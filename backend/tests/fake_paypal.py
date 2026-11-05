"""An in-memory stand-in for the PayPal Sandbox REST API, so tests run offline and can play the buyer.

Test-only: the app itself always talks to the PayPal Sandbox. It mirrors the Orders v2 / Payments v2
behaviour the app depends on: PayPal-Request-Id idempotency, amount-breakdown validation,
CREATED -> APPROVED -> COMPLETED, INSTRUMENT_DECLINED (PayPal-Mock-Response), pending captures and
refunds, and webhooks that carry PayPal's transmission headers.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import json
import secrets
import string
import threading
from datetime import timedelta
from decimal import Decimal
from typing import Any

from app import clock
from app.payments.base import PayPalError

_ALNUM = string.ascii_uppercase + string.digits
_WEBHOOK_KEY = b"fake-paypal-webhook-key"
PENDING_RESOLVE_SECONDS = 10


def _pid(prefix: str) -> str:
    return prefix + "".join(secrets.choice(_ALNUM) for _ in range(17 - len(prefix)))


def _now() -> str:
    return clock.iso(clock.now())  # type: ignore[return-value]


def _public(node: Any) -> Any:
    """Drop the fake's private bookkeeping keys (prefixed with _)."""
    if isinstance(node, dict):
        return {k: _public(v) for k, v in node.items() if not k.startswith("_")}
    if isinstance(node, list):
        return [_public(v) for v in node]
    return node


def _due(item: dict[str, Any]) -> bool:
    return item.get("status") == "PENDING" and bool(item.get("_resolve_at")) and clock.now().isoformat() >= item["_resolve_at"]


class FakePayPal:
    environment = "sandbox"

    def __init__(self) -> None:
        self.orders: dict[str, dict[str, Any]] = {}
        self.requests: dict[str, tuple[str, dict[str, Any]]] = {}  # PayPal-Request-Id -> (operation, response)
        self.outbox: list[dict[str, Any]] = []  # webhook events PayPal would send
        self.mock_next_capture: str | None = None
        self.capture_pending = False  # the next capture comes back PENDING
        self.refund_pending = False  # the next refund comes back PENDING
        self.invalid_payees: set[str] = set()  # payee merchant IDs / emails PayPal would reject
        self.assertions: list[str | None] = []  # PayPal-Auth-Assertion values seen on refunds
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ the buyer, in PayPal's window

    def approve(self, order_id: str, payer_name: str = "Sandbox Buyer") -> dict[str, Any]:
        with self._lock:
            order = self._order(order_id)
            if order["status"] not in ("CREATED", "PAYER_ACTION_REQUIRED", "APPROVED"):
                raise PayPalError(422, "UNPROCESSABLE_ENTITY", f"Order is {order['status']}", issue="ORDER_NOT_APPROVABLE")
            order["status"] = "APPROVED"
            order["payer"] = {"name": {"given_name": payer_name.split(" ")[0]}, "payer_id": _pid("PAYER")}
            return _public(copy.deepcopy(order))

    def captures(self, order_id: str) -> list[dict[str, Any]]:
        return _public(self._order(order_id)["purchase_units"][0].get("payments", {}).get("captures", []))

    def calls(self, operation: str) -> int:
        """How many distinct requests (by PayPal-Request-Id) reached PayPal for an operation."""
        return sum(1 for op, _ in self.requests.values() if op == operation)

    # ------------------------------------------------------------------ Orders v2

    def create_order(self, body: dict[str, Any], request_id: str) -> dict[str, Any]:
        with self._lock:
            if (replay := self._replay(request_id, "create_order")) is not None:
                return replay
            self._validate(body)
            status = "PAYER_ACTION_REQUIRED" if body.get("payment_source") else "CREATED"
            order = {"id": _pid("FAKE"), "intent": body["intent"], "status": status,
                     "purchase_units": copy.deepcopy(body["purchase_units"]), "create_time": _now()}
            self.orders[order["id"]] = order
            return self._remember(request_id, "create_order", order)

    def _validate(self, body: dict[str, Any]) -> None:
        if body.get("intent") != "CAPTURE":
            raise PayPalError(422, "UNPROCESSABLE_ENTITY", "Only CAPTURE intent is supported", issue="UNSUPPORTED_INTENT")
        units = body.get("purchase_units") or []
        if len(units) != 1:
            raise PayPalError(400, "INVALID_REQUEST", "Exactly one purchase unit is required", issue="INVALID_PARAMETER_VALUE")
        amount = units[0].get("amount") or {}
        breakdown = amount.get("breakdown") or {}
        items = units[0].get("items") or []

        def part(name: str) -> Decimal:
            return Decimal(breakdown.get(name, {}).get("value", "0"))

        if items and part("item_total") != sum(Decimal(i["unit_amount"]["value"]) * int(i["quantity"]) for i in items):
            raise PayPalError(422, "UNPROCESSABLE_ENTITY", "Item amount mismatch", issue="ITEM_TOTAL_MISMATCH")
        expected = part("item_total") + part("tax_total") + part("handling") + part("shipping") - part("discount")
        if breakdown and Decimal(amount.get("value", "0")) != expected:
            raise PayPalError(422, "UNPROCESSABLE_ENTITY", "Amount does not match the breakdown", issue="AMOUNT_MISMATCH")
        if any(i["unit_amount"]["currency_code"] != amount.get("currency_code") for i in items):
            raise PayPalError(422, "UNPROCESSABLE_ENTITY", "Currency mismatch", issue="CURRENCY_MISMATCH")
        payee = units[0].get("payee") or {}
        if payee and (payee.get("merchant_id") in self.invalid_payees or payee.get("email_address") in self.invalid_payees):
            raise PayPalError(422, "UNPROCESSABLE_ENTITY", "Payee account is invalid", issue="PAYEE_ACCOUNT_INVALID")

    def get_order(self, order_id: str) -> dict[str, Any]:
        with self._lock:
            order = self._order(order_id)
            self._resolve_pending(order)
            return _public(copy.deepcopy(order))

    def capture_order(self, order_id: str, request_id: str) -> dict[str, Any]:
        with self._lock:
            if (replay := self._replay(request_id, "capture")) is not None:
                return replay
            mock, self.mock_next_capture = self.mock_next_capture, None
            pending, self.capture_pending = self.capture_pending, False
            order = self._order(order_id)
            if order["status"] == "COMPLETED":
                raise PayPalError(422, "UNPROCESSABLE_ENTITY", "Order already captured", issue="ORDER_ALREADY_CAPTURED")
            if order["status"] != "APPROVED":
                raise PayPalError(422, "UNPROCESSABLE_ENTITY", "Payer has not yet approved the Order for payment.", issue="ORDER_NOT_APPROVED")
            if mock == "INSTRUMENT_DECLINED":
                raise PayPalError(422, "UNPROCESSABLE_ENTITY", "The instrument presented was declined.", issue="INSTRUMENT_DECLINED")
            unit = order["purchase_units"][0]
            amount = {k: v for k, v in unit["amount"].items() if k != "breakdown"}
            capture = {"id": _pid("CAP"), "status": "PENDING" if pending else "COMPLETED", "amount": amount, "final_capture": True,
                       "invoice_id": unit.get("invoice_id"), "custom_id": unit.get("custom_id"), "create_time": _now(), "update_time": _now()}
            if pending:
                capture["status_details"] = {"reason": "PENDING_REVIEW"}
                capture["_resolve_at"] = (clock.now() + timedelta(seconds=PENDING_RESOLVE_SECONDS)).isoformat()
            unit["payments"] = {"captures": [capture]}
            order["status"] = "COMPLETED"
            response = self._remember(request_id, "capture", order)
        self._emit("PAYMENT.CAPTURE.PENDING" if pending else "PAYMENT.CAPTURE.COMPLETED", "capture", capture, order_id)
        return response

    # ------------------------------------------------------------------ Payments v2

    def _find_capture(self, capture_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        for order in self.orders.values():
            for capture in order["purchase_units"][0].get("payments", {}).get("captures", []):
                if capture["id"] == capture_id:
                    return order, capture
        raise PayPalError(404, "RESOURCE_NOT_FOUND", "Capture not found", issue="INVALID_RESOURCE_ID")

    @staticmethod
    def _assertion_matches(assertion: str | None, payee: dict[str, Any]) -> bool:
        if not payee:
            return True  # the platform's own transaction
        if not assertion:
            return False
        claims = json.loads(base64.urlsafe_b64decode(assertion.split(".")[1] + "==="))
        return claims.get("payer_id") == payee.get("merchant_id") if payee.get("merchant_id") else claims.get("email") == payee.get("email_address")

    def get_capture(self, capture_id: str, auth_assertion: str | None = None) -> dict[str, Any]:
        with self._lock:
            order, capture = self._find_capture(capture_id)
            self._resolve_pending(order)
            return _public(copy.deepcopy(capture)) | {"supplementary_data": {"related_ids": {"order_id": order["id"]}}}

    def refund_capture(self, capture_id: str, body: dict[str, Any], request_id: str, auth_assertion: str | None = None) -> dict[str, Any]:
        with self._lock:
            self.assertions.append(auth_assertion)
            if (replay := self._replay(request_id, "refund")) is not None:
                return replay
            order, capture = self._find_capture(capture_id)
            if not self._assertion_matches(auth_assertion, order["purchase_units"][0].get("payee") or {}):
                raise PayPalError(403, "NOT_AUTHORIZED", "Authorization failed due to insufficient permissions", issue="PERMISSION_DENIED")
            pending, self.refund_pending = self.refund_pending, False
            if capture["status"] not in ("COMPLETED", "PARTIALLY_REFUNDED"):
                raise PayPalError(422, "UNPROCESSABLE_ENTITY", f"Capture is {capture['status']}",
                                  issue="CAPTURE_FULLY_REFUNDED" if capture["status"] == "REFUNDED" else "INVALID_CAPTURE_STATE")
            captured = Decimal(capture["amount"]["value"])
            refunded = sum(Decimal(r["amount"]["value"]) for r in capture.get("_refunds", []) if r["status"] in ("COMPLETED", "PENDING"))
            amount = Decimal(body["amount"]["value"])
            if amount <= 0 or refunded + amount > captured:
                raise PayPalError(422, "UNPROCESSABLE_ENTITY", "Refund amount exceeds the refundable amount", issue="REFUND_AMOUNT_EXCEEDED")
            refund = {"id": _pid("REF"), "status": "PENDING" if pending else "COMPLETED", "amount": body["amount"],
                      "invoice_id": body.get("invoice_id"), "create_time": _now()}
            if pending:
                refund["_resolve_at"] = (clock.now() + timedelta(seconds=PENDING_RESOLVE_SECONDS)).isoformat()
            capture.setdefault("_refunds", []).append(refund)
            capture["status"] = "REFUNDED" if refunded + amount == captured else "PARTIALLY_REFUNDED"
            response = self._remember(request_id, "refund", refund)
        if not pending:
            self._emit("PAYMENT.CAPTURE.REFUNDED", "refund", refund, order["id"], capture_id=capture_id)
        return response

    def get_refund(self, refund_id: str, auth_assertion: str | None = None) -> dict[str, Any]:
        with self._lock:
            for order in self.orders.values():
                self._resolve_pending(order)
                for capture in order["purchase_units"][0].get("payments", {}).get("captures", []):
                    for refund in capture.get("_refunds", []):
                        if refund["id"] == refund_id:
                            return _public(copy.deepcopy(refund))
        raise PayPalError(404, "RESOURCE_NOT_FOUND", "Refund not found", issue="INVALID_RESOURCE_ID")

    # ------------------------------------------------------------------ Webhooks

    def signed(self, raw_body: str, *, valid: bool = True) -> dict[str, str]:
        """Transmission headers PayPal sends with a webhook (a test HMAC stands in for its certificate signature)."""
        transmission_id, sent_at = secrets.token_hex(8), _now()
        signature = hmac.new(_WEBHOOK_KEY, f"{transmission_id}|{sent_at}|{raw_body}".encode(), hashlib.sha256).hexdigest()
        return {"paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-FAKE",
                "paypal-transmission-id": transmission_id, "paypal-transmission-time": sent_at,
                "paypal-transmission-sig": signature if valid else "forged"}

    def verify_webhook(self, headers: dict[str, str], raw_body: str) -> bool:
        h = {k.lower(): v for k, v in headers.items()}
        expected = hmac.new(_WEBHOOK_KEY, f"{h.get('paypal-transmission-id')}|{h.get('paypal-transmission-time')}|{raw_body}".encode(),
                            hashlib.sha256).hexdigest()
        return hmac.compare_digest(h.get("paypal-transmission-sig", ""), expected)

    def deliver_webhooks(self) -> list[dict[str, Any]]:
        """Post every queued event to the app, as PayPal would shortly after the API call."""
        from app.services import webhooks  # noqa: PLC0415 - the app's receiver, imported on use

        results = []
        while self.outbox:
            raw = json.dumps(self.outbox.pop(0), separators=(",", ":"))
            results.append(webhooks.receive(self.signed(raw), raw))
        return results

    def check_connection(self) -> dict[str, Any]:
        return {"ok": True, "environment": "sandbox", "base_url": "https://api-m.sandbox.paypal.com", "webhook_configured": True}

    # ------------------------------------------------------------------ internals

    def _order(self, order_id: str) -> dict[str, Any]:
        order = self.orders.get(order_id)
        if order is None:
            raise PayPalError(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", issue="INVALID_RESOURCE_ID")
        return order

    def _replay(self, request_id: str, operation: str) -> dict[str, Any] | None:
        seen = self.requests.get(request_id)
        if seen is None:
            return None
        if seen[0] != operation:
            raise PayPalError(422, "UNPROCESSABLE_ENTITY", "PayPal-Request-Id reused for a different operation", issue="DUPLICATE_REQUEST_ID")
        return copy.deepcopy(seen[1])

    def _remember(self, request_id: str, operation: str, response: dict[str, Any]) -> dict[str, Any]:
        public = _public(copy.deepcopy(response))
        self.requests[request_id] = (operation, public)
        return copy.deepcopy(public)

    def _resolve_pending(self, order: dict[str, Any]) -> None:
        for capture in order["purchase_units"][0].get("payments", {}).get("captures", []):
            if _due(capture):
                capture["status"] = "COMPLETED"
                capture.pop("status_details", None)
                capture["update_time"] = _now()
            for refund in capture.get("_refunds", []):
                if _due(refund):
                    refund["status"] = "COMPLETED"

    def _emit(self, event_type: str, resource_type: str, resource: dict[str, Any], order_id: str, capture_id: str | None = None) -> None:
        related = {"order_id": order_id} | ({"capture_id": capture_id} if capture_id else {})
        self.outbox.append({"id": "WH-" + _pid("")[:12] + "-" + secrets.token_hex(4).upper(), "event_version": "1.0",
                            "create_time": _now(), "resource_type": resource_type, "event_type": event_type,
                            "summary": f"{event_type} (test)",
                            "resource": _public(copy.deepcopy(resource)) | {"supplementary_data": {"related_ids": related}}})
