"""Operational endpoints: liveness/readiness for the load balancer and Prometheus metrics."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, PlainTextResponse

from app import clock
from app.config import settings
from app.db import ping, transaction
from app.errors import NotFound, Unauthorized
from app.ids import constant_time_equal
from app.migrate import current_revision
from app.models import SystemState
from app.observability import metrics
from app.services import media, webhooks

router = APIRouter(prefix="/api", tags=["system"])

WORKER_STALE_SECONDS = 60


@router.get("/health/live")
def live() -> dict[str, str]:
    """The process is up (no dependencies checked)."""
    return {"status": "ok"}


@router.get("/health")
def health() -> JSONResponse:
    """Readiness: 503 only when the database is unreachable; other problems report as degraded."""
    checks: dict[str, Any] = {}
    status = "ok"
    try:
        checks["database"] = {"ok": ping()}
    except Exception as exc:  # noqa: BLE001
        checks["database"] = {"ok": False, "error": exc.__class__.__name__}
        return JSONResponse({"status": "down", "checks": checks}, status_code=503)
    checks["migrations"] = {"revision": current_revision()}
    if settings().worker_enabled:
        with transaction() as db:
            beat = db.get(SystemState, "worker_heartbeat")
        if beat:
            age = (clock.now() - _parse(beat.value["at"])).total_seconds()
            checks["worker"] = {"ok": age < WORKER_STALE_SECONDS, "last_heartbeat_seconds_ago": round(age, 1)}
            if age >= WORKER_STALE_SECONDS:
                status = "degraded"
        else:
            checks["worker"] = {"ok": False, "detail": "no heartbeat yet"}
            status = "degraded"
    checks["paypal"] = {"configured": settings().paypal_configured, "webhooks": bool(settings().paypal_webhook_id)}
    if not settings().paypal_configured:
        status = "degraded"
    return JSONResponse({"status": status, "checks": checks, "time": clock.iso(clock.now())})


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@router.get("/metrics", response_class=PlainTextResponse)
def prometheus(request: Request) -> str:
    token = settings().metrics_token
    if token:
        supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if not supplied or not constant_time_equal(supplied, token):
            raise Unauthorized("Metrics token required", code="metrics_token_required")
    elif settings().is_production:
        raise NotFound("Not found")
    return metrics.render()


@router.post("/webhooks/paypal")
async def paypal_webhook(request: Request) -> dict[str, Any]:
    """Verify, de-duplicate and queue PayPal events. The raw body is kept byte-for-byte for verification."""
    raw = (await request.body()).decode("utf-8")
    headers = {k: v for k, v in request.headers.items()}
    return await run_in_threadpool(webhooks.receive, headers, raw)


@router.get("/credits")
def photo_credits() -> dict[str, Any]:
    """Author, source and licence for every openly licensed photo a live shop shows."""
    with transaction() as db:
        return {"photos": media.credits(db)}


@router.get("/assets/{asset_id}")
def asset(asset_id: str, request: Request, size: str = Query(default="full", pattern="^(full|thumb)$")) -> Response:
    """Stored photos. Assets are immutable, so they're cached for a year and revalidated by ETag."""
    with transaction() as db:
        data, content_type, etag = media.load(db, asset_id, size)
    headers = {"ETag": etag, "Cache-Control": "public, max-age=31536000, immutable"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type=content_type, headers=headers)
