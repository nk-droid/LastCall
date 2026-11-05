"""Refunds through the PayPal Payments API, reviewed by a manager (or by shop policy for missed pickups).

A refund is pending until PayPal confirms it; the exact amount and provider IDs are kept. A
lost response becomes OUTCOME_UNKNOWN and is resolved by replaying the request with the same
PayPal-Request-Id (which returns the original refund) or by looking the refund up.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.config import settings
from app.db import transaction
from app.errors import Conflict, NotFound, ProviderError, Unprocessable
from app.ids import new_id, new_request_id
from app.models import Merchant, Order, PaymentAttempt, Refund, Reservation
from app.money import format_money, to_decimal_string
from app.payments import get_client
from app.payments.base import PayPalError, PayPalOutcomeUnknown
from app.payments.payee import auth_assertion
from app.services import analytics, audit, jobs
from app.services import reservations as rsv
from app.services.access import StaffContext, require_role
from app.services.alerts import raise_alert, resolve_alerts
from app.services.catalog import merchant_by_id


def refund_summary(db: Session, order: Order) -> dict[str, Any]:
    rows = db.scalars(select(Refund).where(Refund.order_id == order.id).order_by(Refund.created_at)).all()
    return {
        "order_id": order.id, "order_number": order.order_number, "payment_status": order.payment_status,
        "fulfillment_status": order.fulfillment_status, "refund_status": order.refund_status,
        "refunds": [{"id": r.id, "amount_minor": r.amount_minor, "currency": r.currency, "state": r.state, "provider_status": r.provider_status,
                     "paypal_refund_id": r.paypal_refund_id, "reason": r.reason, "requested_by": r.requested_by,
                     "created_at": clock.iso(r.created_at), "completed_at": clock.iso(r.completed_at)} for r in rows],
    }


def system_actor(merchant: Merchant) -> StaffContext:
    """The shop's own policy acting automatically (e.g. a no-show refund), audited as such."""
    return StaffContext(id="system", email="policy@lastcall", display_name="Shop policy (automatic)", role="owner",
                        merchant_id=merchant.id, merchant_slug=merchant.slug, merchant_status=merchant.status)


class RefundRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=300)
    return_to_stock: bool = True
    amount_minor: int | None = Field(default=None, ge=1)


def refund_order(user: StaffContext, order_id: str, req: RefundRequest) -> dict[str, Any]:
    """Merchant-reviewed refund through the Payments API, with exact amounts and provider IDs kept."""
    require_role(user, "manager")
    client = get_client()
    with transaction() as db:
        merchant = merchant_by_id(db, user.merchant_id)
        order = db.get(Order, order_id, with_for_update=True)
        if order is None or order.merchant_id != user.merchant_id:
            raise NotFound("Order not found")
        attempt = db.scalar(select(PaymentAttempt).where(PaymentAttempt.order_id == order.id, PaymentAttempt.state == "CAPTURED").with_for_update())
        if attempt is None or not attempt.capture_id:
            raise Conflict("There is no verified capture to refund", code="nothing_to_refund")
        refunds = db.scalars(select(Refund).where(Refund.order_id == order.id)).all()
        if any(r.state in ("REQUESTED", "OUTCOME_UNKNOWN", "PENDING") for r in refunds):
            raise Conflict("A refund for this order is already in progress", code="refund_in_progress")
        refunded = sum(r.amount_minor for r in refunds if r.state == "COMPLETED")
        refundable = (attempt.captured_amount_minor or 0) - refunded
        amount = req.amount_minor or refundable
        if amount <= 0 or amount > refundable:
            raise Unprocessable(f"Refundable amount is {format_money(refundable, order.currency)}", code="invalid_refund_amount")
        if order.fulfillment_status == "PICKED_UP" and req.return_to_stock:
            raise Unprocessable("Picked-up items can't be returned to stock", code="cannot_restock")
        now = clock.now()
        refund = Refund(id=new_id("rfd"), payment_attempt_id=attempt.id, order_id=order.id, amount_minor=amount, currency=order.currency,
                        request_id=new_request_id(), state="REQUESTED", reason=req.reason, requested_by=user.actor, return_to_stock=req.return_to_stock)
        db.add(refund)
        order.refund_status = "REQUESTED"
        full = amount == (attempt.captured_amount_minor or 0) - refunded and refunded == 0
        if full and order.fulfillment_status in ("NEW", "PACKING", "READY"):
            res = db.get(Reservation, order.reservation_id, with_for_update=True)
            if req.return_to_stock:
                rsv.release(db, res, "order_cancelled", now, actor=user.actor, role=user.role)
            else:
                rsv.write_off(db, res, merchant, now, user.actor, order.id, "Cancelled order not returned to stock")
            order.fulfillment_status = "CANCELLED"
            order.cancelled_at = now
            audit.record(db, actor=user.actor, actor_role=user.role, entity_type="order", entity_id=order.id, action="order_cancelled",
                         meta={"return_to_stock": req.return_to_stock}, trace_id=order.trace_id)
        if order.cancel_request and order.cancel_request.get("status") == "requested":
            order.cancel_request = {**order.cancel_request, "status": "approved", "decided_at": clock.iso(now), "decided_by": user.display_name}
            resolve_alerts(db, merchant.id, "cancellation_request", order.id)
        audit.record(db, actor=user.actor, actor_role=user.role, entity_type="refund", entity_id=refund.id, action="refund_requested",
                     meta={"amount_minor": amount, "capture_id": attempt.capture_id, "request_id": refund.request_id, "reason": req.reason}, trace_id=order.trace_id)
        refund_id, capture_id, request_id = refund.id, attempt.capture_id, refund.request_id
        assertion = auth_assertion(settings().paypal_client_id or "", attempt.payee)
        body = {
            "amount": {"value": to_decimal_string(amount, order.currency), "currency_code": order.currency},
            "invoice_id": f"{order.order_number}-R-{refund.id[-6:]}",
            "note_to_payer": f"Refund for {merchant.name} order {order.order_number}"[:255],
        }
    _send_refund(client, refund_id, capture_id, body, request_id, assertion)
    with transaction() as db:
        return refund_summary(db, db.get(Order, order_id))


def _send_refund(client: Any, refund_id: str, capture_id: str, body: dict[str, Any], request_id: str, assertion: str | None) -> None:
    try:
        result = client.refund_capture(capture_id, body, request_id, auth_assertion=assertion)
    except PayPalOutcomeUnknown as exc:
        with transaction() as db:
            refund = db.get(Refund, refund_id, with_for_update=True)
            refund.state = "OUTCOME_UNKNOWN"
            refund.last_error = {"kind": "outcome_unknown", "detail": str(exc)}
            order = db.get(Order, refund.order_id, with_for_update=True)
            order.refund_status = "PENDING"
            jobs.enqueue("refunds.reconcile", {"refund_id": refund_id}, delay_seconds=5, dedupe_key=f"refund:{refund_id}", db=db)
        return
    except PayPalError as exc:
        with transaction() as db:
            refund = db.get(Refund, refund_id, with_for_update=True)
            refund.state = "FAILED"
            refund.last_error = exc.to_dict()
            order = db.get(Order, refund.order_id, with_for_update=True)
            order.refund_status = "FAILED"
            audit.record(db, actor="provider:paypal", actor_role="system", entity_type="refund", entity_id=refund.id, action="refund_failed",
                         meta=exc.to_dict(), trace_id=order.trace_id)
            raise_alert(db, order.merchant_id, "refund_failed", "order", order.id, f"{order.order_number}: PayPal rejected the refund ({exc.issue or exc.name})", "high")
        raise ProviderError("PayPal rejected the refund", code="refund_failed", details=exc.to_dict()) from exc
    apply_refund_result(refund_id, result)


def apply_refund_result(refund_id: str, result: dict[str, Any]) -> str:
    with transaction() as db:
        refund = db.get(Refund, refund_id, with_for_update=True)
        order = db.get(Order, refund.order_id, with_for_update=True)
        status = result.get("status")
        refund.paypal_refund_id = refund.paypal_refund_id or result.get("id")
        refund.provider_status = status
        amount = (result.get("amount") or {}).get("value")
        if amount and amount != to_decimal_string(refund.amount_minor, refund.currency):
            refund.last_error = {"kind": "refund_amount_mismatch", "provider_amount": amount}
            raise_alert(db, order.merchant_id, "refund_mismatch", "order", order.id, f"{order.order_number}: refund amount differs at PayPal ({amount})", "high")
        if refund.state == "COMPLETED":
            return "already_completed"
        if status == "COMPLETED":
            refund.state = "COMPLETED"
            refund.completed_at = clock.now()
            order.refund_status = "COMPLETED"
            analytics.track(db, "refund_verified", merchant_id=order.merchant_id, session_id=order.session_id, entity_type="refund",
                            entity_id=refund.id, properties={"amount_minor": refund.amount_minor})
            audit.record(db, actor="provider:paypal", actor_role="system", entity_type="refund", entity_id=refund.id, action="refund_completed",
                         meta={"paypal_refund_id": refund.paypal_refund_id, "amount_minor": refund.amount_minor}, trace_id=order.trace_id)
            return "completed"
        if status in ("PENDING", None):
            refund.state = "PENDING"
            order.refund_status = "PENDING"
            jobs.enqueue("refunds.reconcile", {"refund_id": refund.id}, delay_seconds=15, dedupe_key=f"refund:{refund.id}", db=db)
            return "pending"
        refund.state = "FAILED"
        order.refund_status = "FAILED"
        raise_alert(db, order.merchant_id, "refund_failed", "order", order.id, f"{order.order_number}: refund {status} at PayPal", "high")
        return "failed"


def reconcile_refund(refund_id: str) -> str:
    client = get_client()
    with transaction() as db:
        refund = db.get(Refund, refund_id)
        if refund is None or refund.state in ("COMPLETED", "FAILED"):
            return "noop"
        attempt = db.get(PaymentAttempt, refund.payment_attempt_id)
        order = db.get(Order, refund.order_id)
        paypal_refund_id, capture_id, request_id = refund.paypal_refund_id, attempt.capture_id, refund.request_id
        assertion = auth_assertion(settings().paypal_client_id or "", attempt.payee)
        body = {"amount": {"value": to_decimal_string(refund.amount_minor, refund.currency), "currency_code": refund.currency},
                "invoice_id": f"{order.order_number}-R-{refund.id[-6:]}"}
    try:
        if paypal_refund_id:
            result = client.get_refund(paypal_refund_id, auth_assertion=assertion)
        else:
            # Response was lost: replaying with the same PayPal-Request-Id returns the original refund.
            result = client.refund_capture(capture_id, body, request_id, auth_assertion=assertion)
    except PayPalOutcomeUnknown as exc:
        raise jobs.RetryLater(str(exc)) from exc
    return apply_refund_result(refund_id, result)


@jobs.handler("refunds.reconcile")
def _reconcile(payload: dict[str, Any]) -> dict[str, Any]:
    return {"result": reconcile_refund(payload["refund_id"])}


@jobs.handler("refunds.auto_no_show")
def _no_show_refund(payload: dict[str, Any]) -> dict[str, Any]:
    with transaction() as db:
        order = db.get(Order, payload["order_id"])
        if order is None or order.fulfillment_status in ("PICKED_UP", "CANCELLED"):
            return {"result": "skipped"}
        actor = system_actor(merchant_by_id(db, order.merchant_id))
    refund_order(actor, payload["order_id"], RefundRequest(reason="Missed pickup (automatic per shop policy)", return_to_stock=False))
    return {"result": "refund_requested"}
