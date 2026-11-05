"""FastAPI application: middleware (correlation IDs, CSRF origin check, security headers,
access logs), error envelopes, and startup (migrations, background worker)."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app import db
from app.api import auth, inventory, ops, public, shopping, shops, system, team
from app.config import settings
from app.errors import AppError
from app.migrate import upgrade_head
from app.observability import correlation_id_var, metrics, setup_logging, trace_id_var
from app.services.jobs import Worker

log = logging.getLogger("lastcall")
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
# Server-to-server callers that don't send a browser Origin we could check.
CSRF_EXEMPT_PREFIXES = ("/api/webhooks/",)
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
}


def _origin_of(url: str | None) -> str | None:
    if not url:
        return None
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    s = settings()
    setup_logging(s.log_level, s.log_json)
    s.validate_for_startup()
    db.configure()
    if s.auto_migrate:
        upgrade_head()
    worker = Worker(s.worker_interval_seconds) if s.worker_enabled else None
    if worker:
        worker.start()
    log.info("LastCall API ready", extra={"env": s.app_env, "worker": bool(worker)})
    try:
        yield
    finally:
        if worker:
            worker.stop()


def create_app() -> FastAPI:
    s = settings()
    app = FastAPI(
        title="LastCall API",
        version="1.0.0",
        lifespan=lifespan,
        description="Surplus bundles for local food shops: catalog, AI-assisted bundles, quotes, reservations, PayPal checkout, fulfillment.",
        docs_url=None if s.is_production else "/api/docs",
        redoc_url=None,
        openapi_url=None if s.is_production else "/api/openapi.json",
    )

    @app.middleware("http")
    async def context(request: Request, call_next):
        cid = request.headers.get("x-request-id") or uuid.uuid4().hex
        cid_token = correlation_id_var.set(cid[:64])
        trace_token = trace_id_var.set(None)
        started = time.perf_counter()
        try:
            path = request.url.path
            if request.method in UNSAFE and path.startswith("/api/") and not path.startswith(CSRF_EXEMPT_PREFIXES):
                origin = request.headers.get("origin") or _origin_of(request.headers.get("referer"))
                allowed = settings().allowed_origins | {str(request.base_url).rstrip("/")}
                if origin and origin.rstrip("/") not in allowed:
                    metrics.inc("lastcall_csrf_blocked_total")
                    return JSONResponse({"error": {"code": "csrf_rejected", "message": "Cross-site request blocked"}}, status_code=403)
            response = await call_next(request)
            elapsed = time.perf_counter() - started
            response.headers["x-request-id"] = cid
            for name, value in SECURITY_HEADERS.items():
                response.headers.setdefault(name, value)
            if path.startswith("/api/") and "cache-control" not in response.headers:
                response.headers["Cache-Control"] = "no-store"
            route = request.scope.get("route")
            label = getattr(route, "path", "unmatched")
            metrics.inc("lastcall_http_requests_total", method=request.method, route=label, status=str(response.status_code))
            metrics.observe("lastcall_http_request_seconds", elapsed, route=label)
            if not path.startswith("/api/health"):
                log.info("request", extra={"method": request.method, "path": path, "status": response.status_code, "latency_ms": int(elapsed * 1000)})
            return response
        finally:
            correlation_id_var.reset(cid_token)
            trace_id_var.reset(trace_token)

    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError) -> JSONResponse:
        body = exc.to_dict()
        body["error"]["correlation_id"] = correlation_id_var.get()
        return JSONResponse(body, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = []
        for err in exc.errors():
            loc = [str(part) for part in err.get("loc", []) if part not in ("body", "query", "path")]
            message = str(err.get("msg", "Invalid value")).removeprefix("Value error, ")
            details.append({"field": ".".join(loc), "message": message})
        return JSONResponse({"error": {"code": "validation_error", "message": details[0]["message"] if len(details) == 1 else "Please check the highlighted fields",
                                       "details": details, "correlation_id": correlation_id_var.get()}}, status_code=422)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error", extra={"path": request.url.path})
        return JSONResponse({"error": {"code": "internal_error", "message": "Something went wrong on our side. Please try again.",
                                       "correlation_id": correlation_id_var.get()}}, status_code=500)

    for module in (system, auth, team, shops, public, shopping, inventory, ops):
        app.include_router(module.router)
    return app


app = create_app()
