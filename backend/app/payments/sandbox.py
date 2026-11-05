"""PayPal REST client (Orders v2, Payments v2, Webhooks) for the Sandbox environment.

The API host is fixed to the Sandbox, so test credentials can never move real money.
Credentials stay server-side. Every mutating call carries a durable PayPal-Request-Id so a
retry after a lost response returns the original result instead of charging twice.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

import httpx

from app.observability import metrics
from app.payments.base import PayPalError, PayPalOutcomeUnknown

log = logging.getLogger(__name__)

SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com"


class SandboxPayPalClient:
    environment = "sandbox"

    def __init__(self, client_id: str, client_secret: str, webhook_id: str | None, timeout: float):
        self.base_url = SANDBOX_API_BASE
        self._client_id = client_id
        self._client_secret = client_secret
        self.webhook_id = webhook_id
        self._http = httpx.Client(base_url=self.base_url, timeout=httpx.Timeout(timeout, connect=5.0))
        self._token: str | None = None
        self._token_expiry = 0.0
        self._lock = threading.Lock()
        self.mock_next_capture: str | None = None  # PayPal-Mock-Response negative testing (Sandbox only)

    # ------------------------------------------------------------------ plumbing

    def _access_token(self, force: bool = False) -> str:
        with self._lock:
            if not force and self._token and time.time() < self._token_expiry - 60:
                return self._token
            try:
                response = self._http.post(
                    "/v1/oauth2/token",
                    data={"grant_type": "client_credentials"},
                    auth=(self._client_id, self._client_secret),
                    headers={"Accept": "application/json"},
                )
            except httpx.HTTPError as exc:
                raise PayPalOutcomeUnknown("oauth", exc.__class__.__name__) from exc
            if response.status_code != 200:
                raise PayPalError(response.status_code, "AUTHENTICATION_FAILURE", "Could not obtain a PayPal access token")
            data = response.json()
            self._token = data["access_token"]
            self._token_expiry = time.time() + int(data.get("expires_in", 300))
            return self._token

    def _request(self, method: str, path: str, *, op: str, body: dict[str, Any] | None = None,
                 request_id: str | None = None, extra_headers: dict[str, str] | None = None,
                 raw_content: str | None = None) -> dict[str, Any]:
        for attempt in range(2):
            headers = {
                "Authorization": f"Bearer {self._access_token(force=attempt > 0)}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Prefer": "return=representation",
            }
            if request_id:
                headers["PayPal-Request-Id"] = request_id
            headers.update(extra_headers or {})
            started = time.perf_counter()
            try:
                if raw_content is not None:
                    response = self._http.request(method, path, content=raw_content.encode(), headers=headers)
                elif body is not None:
                    response = self._http.request(method, path, json=body, headers=headers)
                else:
                    response = self._http.request(method, path, headers=headers)
            except httpx.HTTPError as exc:
                metrics.inc("lastcall_paypal_calls_total", op=op, outcome="unknown")
                raise PayPalOutcomeUnknown(op, exc.__class__.__name__) from exc
            finally:
                metrics.observe("lastcall_paypal_latency_seconds", time.perf_counter() - started, op=op)
            if response.status_code == 401 and attempt == 0:
                continue  # token expired early; refresh once
            debug_id = response.headers.get("paypal-debug-id")
            if response.status_code >= 500:
                metrics.inc("lastcall_paypal_calls_total", op=op, outcome="unknown")
                raise PayPalOutcomeUnknown(op, f"HTTP {response.status_code} debug_id={debug_id}")
            if response.status_code >= 400:
                metrics.inc("lastcall_paypal_calls_total", op=op, outcome="error")
                try:
                    payload = response.json()
                except ValueError:
                    payload = {}
                details = payload.get("details") or []
                issue = details[0].get("issue") if details else None
                raise PayPalError(
                    response.status_code,
                    payload.get("name") or payload.get("error") or "ERROR",
                    payload.get("message") or payload.get("error_description") or response.text[:200],
                    issue=issue,
                    debug_id=payload.get("debug_id") or debug_id,
                    details=details,
                )
            metrics.inc("lastcall_paypal_calls_total", op=op, outcome="ok")
            return response.json() if response.content else {}
        raise PayPalError(401, "AUTHENTICATION_FAILURE", "PayPal rejected the access token")

    # ------------------------------------------------------------------ Orders v2

    def create_order(self, body: dict[str, Any], request_id: str) -> dict[str, Any]:
        return self._request("POST", "/v2/checkout/orders", op="create_order", body=body, request_id=request_id)

    def get_order(self, order_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v2/checkout/orders/{order_id}", op="get_order")

    def capture_order(self, order_id: str, request_id: str) -> dict[str, Any]:
        extra = {}
        if self.mock_next_capture:
            extra["PayPal-Mock-Response"] = json.dumps({"mock_application_codes": self.mock_next_capture})
            self.mock_next_capture = None
        return self._request("POST", f"/v2/checkout/orders/{order_id}/capture", op="capture", request_id=request_id, extra_headers=extra)

    # ------------------------------------------------------------------ Payments v2

    def get_capture(self, capture_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v2/payments/captures/{capture_id}", op="get_capture")

    def refund_capture(self, capture_id: str, body: dict[str, Any], request_id: str) -> dict[str, Any]:
        return self._request("POST", f"/v2/payments/captures/{capture_id}/refund", op="refund", body=body, request_id=request_id)

    def get_refund(self, refund_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v2/payments/refunds/{refund_id}", op="get_refund")

    # ------------------------------------------------------------------ Webhooks

    def verify_webhook(self, headers: dict[str, str], raw_body: str) -> bool:
        """Verify via PayPal's API, splicing the raw event bytes in so nothing is re-serialized."""
        if not self.webhook_id:
            log.warning("PAYPAL_WEBHOOK_ID not configured; rejecting webhook")
            return False
        h = {k.lower(): v for k, v in headers.items()}
        required = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"]
        if any(not h.get(name) for name in required):
            return False
        envelope = (
            "{"
            f'"auth_algo":{json.dumps(h["paypal-auth-algo"])},'
            f'"cert_url":{json.dumps(h["paypal-cert-url"])},'
            f'"transmission_id":{json.dumps(h["paypal-transmission-id"])},'
            f'"transmission_sig":{json.dumps(h["paypal-transmission-sig"])},'
            f'"transmission_time":{json.dumps(h["paypal-transmission-time"])},'
            f'"webhook_id":{json.dumps(self.webhook_id)},'
            f'"webhook_event":{raw_body}'
            "}"
        )
        result = self._request("POST", "/v1/notifications/verify-webhook-signature", op="verify_webhook", raw_content=envelope)
        return result.get("verification_status") == "SUCCESS"

    def check_connection(self) -> dict[str, Any]:
        try:
            self._access_token(force=True)
            return {"ok": True, "environment": "sandbox", "base_url": self.base_url, "webhook_configured": bool(self.webhook_id)}
        except (PayPalError, PayPalOutcomeUnknown) as exc:
            return {"ok": False, "environment": "sandbox", "base_url": self.base_url, "error": str(exc)}
