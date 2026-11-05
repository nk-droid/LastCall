"""PayPal client contract, implemented by the Sandbox client.

Two failure classes matter for money safety:
* ``PayPalError``: PayPal answered with a definitive 4xx; the operation did not happen.
* ``PayPalOutcomeUnknown``: timeout, dropped connection or 5xx; the operation may or may not
  have happened. Callers persist OUTCOME_UNKNOWN and reconcile by provider ID; they never
  create a new payment blindly. Retries reuse the same PayPal-Request-Id.
"""

from __future__ import annotations

from typing import Any, Protocol


class PayPalError(Exception):
    def __init__(self, status: int, name: str, message: str, issue: str | None = None,
                 debug_id: str | None = None, details: list[Any] | None = None):
        super().__init__(f"{status} {name}: {message}")
        self.status = status
        self.name = name
        self.message = message
        self.issue = issue
        self.debug_id = debug_id
        self.details = details or []

    def to_dict(self) -> dict[str, Any]:
        return {"status": self.status, "name": self.name, "message": self.message, "issue": self.issue, "debug_id": self.debug_id}


class PayPalOutcomeUnknown(Exception):
    def __init__(self, operation: str, reason: str):
        super().__init__(f"{operation}: outcome unknown ({reason})")
        self.operation = operation
        self.reason = reason


class PayPalClient(Protocol):
    environment: str
    mock_next_capture: str | None  # Sandbox negative testing: PayPal-Mock-Response for the next capture

    def create_order(self, body: dict[str, Any], request_id: str) -> dict[str, Any]: ...
    def get_order(self, order_id: str) -> dict[str, Any]: ...
    def capture_order(self, order_id: str, request_id: str) -> dict[str, Any]: ...
    def get_capture(self, capture_id: str) -> dict[str, Any]: ...
    def refund_capture(self, capture_id: str, body: dict[str, Any], request_id: str) -> dict[str, Any]: ...
    def get_refund(self, refund_id: str) -> dict[str, Any]: ...
    def verify_webhook(self, headers: dict[str, str], raw_body: str) -> bool: ...
    def check_connection(self) -> dict[str, Any]: ...


def extract_capture(order_json: dict[str, Any]) -> dict[str, Any] | None:
    """The capture inside an order (prefers COMPLETED, then PENDING, then anything)."""
    captures: list[dict[str, Any]] = []
    for unit in order_json.get("purchase_units", []) or []:
        captures.extend(((unit.get("payments") or {}).get("captures")) or [])
    if not captures:
        return None
    for wanted in ("COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "PENDING"):
        for capture in captures:
            if capture.get("status") == wanted:
                return capture
    return captures[0]


def order_amount(order_json: dict[str, Any]) -> tuple[str | None, str | None]:
    units = order_json.get("purchase_units") or []
    if not units:
        return None, None
    amount = units[0].get("amount") or {}
    return amount.get("value"), amount.get("currency_code")


def order_reference(order_json: dict[str, Any]) -> str | None:
    units = order_json.get("purchase_units") or []
    return units[0].get("reference_id") if units else None


def trim(payload: dict[str, Any]) -> dict[str, Any]:
    """Keep provider IDs, statuses and amounts; drop payer PII before persisting."""
    def scrub(node: Any) -> Any:
        if isinstance(node, dict):
            return {k: scrub(v) for k, v in node.items() if k not in {"payer", "payment_source", "shipping", "links", "email_address", "phone"}}
        if isinstance(node, list):
            return [scrub(v) for v in node]
        return node
    return scrub(payload)
