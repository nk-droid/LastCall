"""PayPal client factory. Payments go through the PayPal Sandbox only (test money, never live)."""

from __future__ import annotations

import threading

from app.config import settings
from app.errors import AppError
from app.payments.base import PayPalClient
from app.payments.faults import FaultInjectingClient
from app.payments.sandbox import SandboxPayPalClient

_lock = threading.Lock()
_clients: dict[str, FaultInjectingClient] = {}
_override: dict[str, FaultInjectingClient] = {}


class PayPalNotConfigured(AppError):
    status_code = 503
    code = "paypal_not_configured"


def get_client() -> FaultInjectingClient:
    s = settings()
    with _lock:
        if "client" in _override:
            return _override["client"]
        if not s.paypal_configured:
            raise PayPalNotConfigured("Payments are unavailable: the server has no PayPal credentials "
                                      "(PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET).")
        client = _clients.get(s.paypal_client_id or "")
        if client is None:
            inner = SandboxPayPalClient(s.paypal_client_id or "", s.paypal_client_secret or "", s.paypal_webhook_id, s.paypal_timeout_seconds)
            client = FaultInjectingClient(inner)
            _clients[s.paypal_client_id or ""] = client
        return client


def override_client(client: PayPalClient) -> None:
    """Test helper: send every PayPal call to `client` (a stand-in for the Sandbox API)."""
    with _lock:
        _override["client"] = FaultInjectingClient(client)


def reset_clients() -> None:
    with _lock:
        _clients.clear()
        _override.clear()
