"""Fulfillment: the pickup queue, packing, ready, pickup-code handoff, cancellation decisions and support replies.

Payment and fulfillment are separate fields: only an order with a verified PayPal capture can be
packed or handed off. Handoff needs the customer's code (deterministic, no model involved);
repeated wrong codes lock the order to managers.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.errors import Conflict, NotFound, Unprocessable
from app.models import AuditEvent, BundleQuote, Merchant, Order, PaymentAttempt, Refund, Reservation, SupportRequest, SystemState
from app.security import verify_pickup_code
from app.services import analytics, audit, fees, notify, pickup
from app.services import reservations as rsv
from app.services.access import StaffContext, has_role
from app.services.alerts import resolve_alerts
from app.services.catalog import merchant_by_id

MAX_PICKUP_ATTEMPTS = 5


def _quote(db: Session, order: Order) -> BundleQuote:
    return db.get(BundleQuote, order.quote_id)


def order_summary(db: Session, order: Order, merchant: Merchant, now: datetime) -> dict[str, Any]:
    quote = _quote(db, order)
    attempt = db.scalar(select(PaymentAttempt).where(PaymentAttempt.order_id == order.id).order_by(PaymentAttempt.created_at.desc()).limit(1))
    units = sum(line["qty"] for line in quote.item_lines)
    open_support = db.scalar(select(func.count()).select_from(SupportRequest).where(SupportRequest.order_id == order.id, SupportRequest.status == "open")) or 0
    return {
        "id": order.id,
        "number": order.order_number,
        "customer_name": (order.customer_contact or {}).get("name"),
        "payment_status": order.payment_status,
        "fulfillment_status": order.fulfillment_status,
        "refund_status": order.refund_status,
        "amount_minor": order.amount_minor,
        "currency": order.currency,
        "units": units,
        "pickup_label": f"{clock.display_time(order.pickup_starts_at, merchant.timezone)}–{clock.display_time(order.pickup_ends_at, merchant.timezone)}",
        "pickup_starts_at": clock.iso(order.pickup_starts_at),
        "pickup_slot_id": order.pickup_slot_id,
        "pickup_expired": order.pickup_expired_at is not None,
        "cancel_requested": bool(order.cancel_request and order.cancel_request.get("status") == "requested"),
        "open_support": open_support,
        "exception_flags": order.exception_flags,
        "environment": attempt.environment if attempt else None,
        "created_at": clock.iso(order.created_at),
        "confirmed_at": clock.iso(order.confirmed_at),
    }


def order_queue(user: StaffContext, status: str | None, slot_id: str | None) -> dict[str, Any]:
    with transaction() as db:
        merchant = merchant_by_id(db, user.merchant_id)
        now = clock.now()
        day_start = clock.combine_local(clock.local_date(merchant.timezone), "00:00", merchant.timezone)
        unfinished = (Order.payment_status == "CAPTURED") & Order.fulfillment_status.in_(["NEW", "PACKING", "READY"])
        query = select(Order).where(Order.merchant_id == user.merchant_id, (Order.pickup_starts_at >= day_start) | unfinished).limit(300)
        if slot_id:
            query = query.where(Order.pickup_slot_id == slot_id)
        orders = db.scalars(query.order_by(Order.pickup_starts_at, Order.created_at)).all()
        groups: dict[str, list[dict[str, Any]]] = {"awaiting_pickup": [], "in_progress": [], "complete": [], "payment_pending": [], "closed": []}
        for order in orders:
            summary = order_summary(db, order, merchant, now)
            if order.payment_status == "CAPTURED":
                if order.fulfillment_status in ("NEW",):
                    groups["awaiting_pickup"].append(summary)
                elif order.fulfillment_status in ("PACKING", "READY"):
                    groups["in_progress"].append(summary)
                else:
                    groups["complete"].append(summary)
            elif order.payment_status in ("RESERVED", "APPROVAL_PENDING", "APPROVED", "CAPTURE_REQUESTED", "OUTCOME_UNKNOWN", "CAPTURE_PENDING"):
                groups["payment_pending"].append(summary)
            else:
                groups["closed"].append(summary)
        if status:
            groups = {k: v for k, v in groups.items() if k == status}
        slots = [pickup.slot_view(s, merchant, now) for s in pickup.list_slots(db, merchant, now - timedelta(hours=12))]
        return {"groups": groups, "slots": slots, "as_of": clock.iso(now)}


def order_detail(user: StaffContext, order_id: str) -> dict[str, Any]:
    with transaction() as db:
        merchant = merchant_by_id(db, user.merchant_id)
        order = db.get(Order, order_id)
        if order is None or order.merchant_id != user.merchant_id:
            raise NotFound("Order not found")
        now = clock.now()
        quote = _quote(db, order)
        attempts = db.scalars(select(PaymentAttempt).where(PaymentAttempt.order_id == order.id).order_by(PaymentAttempt.created_at)).all()
        refunds = db.scalars(select(Refund).where(Refund.order_id == order.id).order_by(Refund.created_at)).all()
        support = db.scalars(select(SupportRequest).where(SupportRequest.order_id == order.id).order_by(SupportRequest.created_at)).all()
        ids = [order.id, *[a.id for a in attempts], *[r.id for r in refunds], order.reservation_id]
        timeline = db.scalars(select(AuditEvent).where(AuditEvent.entity_id.in_(ids)).order_by(AuditEvent.timestamp, AuditEvent.id)).all()
        captured = sum(a.captured_amount_minor or 0 for a in attempts if a.state == "CAPTURED")
        refunded = sum(r.amount_minor for r in refunds if r.state in ("COMPLETED", "PENDING", "REQUESTED", "OUTCOME_UNKNOWN"))
        return {
            **order_summary(db, order, merchant, now),
            "customer_contact": order.customer_contact,
            "lines": [{**line, "packed": line["sku"] in (order.packed_skus or [])} for line in quote.item_lines],
            "totals": {"subtotal_minor": quote.subtotal_minor, "discount_minor": quote.discount_minor, "tax_minor": quote.tax_minor,
                       "fees_minor": quote.fees_minor, "total_minor": quote.amount_minor, "reference_minor": quote.subtotal_reference_minor},
            "pickup_attempts": order.pickup_attempts,
            "pickup_locked": order.pickup_attempts >= MAX_PICKUP_ATTEMPTS,
            "cancel_request": order.cancel_request,
            "refundable_minor": max(0, captured - refunded),
            "payments": [
                {"id": a.id, "state": a.state, "environment": a.environment, "paypal_order_id": a.paypal_order_id, "capture_id": a.capture_id,
                 "request_id": a.request_id, "capture_request_id": a.capture_request_id, "amount_minor": a.amount_minor,
                 "provider_state": a.provider_state, "last_error": a.last_error, "reconcile_count": a.reconcile_count,
                 "created_at": clock.iso(a.created_at), "captured_at": clock.iso(a.captured_at)}
                for a in attempts
            ],
            "platform_fee": fees.order_fee(db, order),
            "refunds": [
                {"id": r.id, "state": r.state, "amount_minor": r.amount_minor, "paypal_refund_id": r.paypal_refund_id, "request_id": r.request_id,
                 "reason": r.reason, "requested_by": r.requested_by, "created_at": clock.iso(r.created_at), "completed_at": clock.iso(r.completed_at)}
                for r in refunds
            ],
            "support": [
                {"id": s.id, "topic": s.topic, "message": s.message, "ai_draft": s.ai_draft, "ai_draft_source": s.ai_draft_source,
                 "ai_checks": s.ai_checks or [], "ai_run_id": s.ai_run_id, "status": s.status, "staff_reply": s.staff_reply, "replied_by": s.replied_by, "created_at": clock.iso(s.created_at)}
                for s in support
            ],
            "timeline": [{"at": clock.iso(e.timestamp), "action": e.action, "actor": e.actor, "entity": e.entity_type, "meta": e.meta} for e in timeline],
            "trace_id": order.trace_id,
        }


class FulfillmentAction(BaseModel):
    action: Literal["start_packing", "mark_ready", "update_packing", "back_to_packing"]
    packed_skus: list[str] | None = None


def fulfillment(user: StaffContext, order_id: str, req: FulfillmentAction) -> dict[str, Any]:
    with transaction() as db:
        order = db.get(Order, order_id, with_for_update=True)
        if order is None or order.merchant_id != user.merchant_id:
            raise NotFound("Order not found")
        if order.payment_status != "CAPTURED":
            raise Conflict("Only orders with a verified PayPal capture can be packed", code="not_paid")
        now = clock.now()
        quote = _quote(db, order)
        skus = {line["sku"] for line in quote.item_lines}
        if req.packed_skus is not None:
            order.packed_skus = sorted(set(req.packed_skus) & skus)
        if req.action == "start_packing":
            if order.fulfillment_status != "NEW":
                raise Conflict(f"Order is {order.fulfillment_status.lower()}", code="invalid_transition")
            order.fulfillment_status = "PACKING"
            audit.record(db, actor=user.actor, actor_role=user.role, entity_type="order", entity_id=order.id, action="fulfillment_packing", trace_id=order.trace_id)
        elif req.action == "mark_ready":
            if order.fulfillment_status not in ("NEW", "PACKING"):
                raise Conflict(f"Order is {order.fulfillment_status.lower()}", code="invalid_transition")
            order.fulfillment_status = "READY"
            order.ready_at = now
            analytics.track(db, "pickup_ready", merchant_id=order.merchant_id, session_id=order.session_id, entity_type="order", entity_id=order.id)
            notified = notify.order_ready(db, order, merchant_by_id(db, order.merchant_id))
            audit.record(db, actor=user.actor, actor_role=user.role, entity_type="order", entity_id=order.id, action="fulfillment_ready",
                         meta={"customer_notified_via": "email and pickup pass" if notified else "pickup pass status"}, trace_id=order.trace_id)
        elif req.action == "back_to_packing":
            if order.fulfillment_status != "READY":
                raise Conflict("Only ready orders can go back to packing", code="invalid_transition")
            order.fulfillment_status = "PACKING"
        order_id_out = order.id
    return order_detail(user, order_id_out)


def handoff(user: StaffContext, order_id: str, code: str, mark_ready: bool = False) -> dict[str, Any]:
    """Verify the customer's pickup code and complete the handoff. Deterministic; no model involved.

    ``mark_ready`` lets the counter hand off an order that is still being packed when its customer is
    already there: it becomes ready and picked up in one step, but only once the code matches.
    """
    wrong = False
    with transaction() as db:
        merchant = merchant_by_id(db, user.merchant_id)
        order = db.get(Order, order_id, with_for_update=True)
        if order is None or order.merchant_id != user.merchant_id:
            raise NotFound("Order not found")
        if order.payment_status != "CAPTURED":
            raise Conflict("Payment isn't verified for this order. Do not hand it off.", code="not_paid")
        if order.fulfillment_status == "PICKED_UP":
            raise Conflict("This order was already handed off", code="already_picked_up")
        if order.fulfillment_status != "READY" and not (mark_ready and order.fulfillment_status in ("NEW", "PACKING")):
            raise Conflict("Mark the order ready before handing it off", code="not_ready")
        if order.pickup_attempts >= MAX_PICKUP_ATTEMPTS and not has_role(user.role, "manager"):
            raise Conflict("Too many incorrect codes. A manager must verify this pickup.", code="pickup_locked")
        now = clock.now()
        if not verify_pickup_code(order.id, code, order.pickup_code_hash):
            order.pickup_attempts += 1
            audit.record(db, actor=user.actor, actor_role=user.role, entity_type="order", entity_id=order.id, action="pickup_code_rejected",
                         meta={"attempts": order.pickup_attempts}, trace_id=order.trace_id)
            wrong = True
            remaining = max(0, MAX_PICKUP_ATTEMPTS - order.pickup_attempts)
        else:
            if order.fulfillment_status != "READY":
                # Packed at the counter: no "ready" email, the customer is standing there.
                order.fulfillment_status = "READY"
                order.ready_at = now
                analytics.track(db, "pickup_ready", merchant_id=order.merchant_id, session_id=order.session_id, entity_type="order", entity_id=order.id)
                audit.record(db, actor=user.actor, actor_role=user.role, entity_type="order", entity_id=order.id, action="fulfillment_ready",
                             meta={"at_handoff": True}, trace_id=order.trace_id)
            res = db.get(Reservation, order.reservation_id, with_for_update=True)
            rsv.fulfill(db, res, merchant, now, user.actor, order.id)
            order.fulfillment_status = "PICKED_UP"
            order.picked_up_at = now
            order.pickup_attempts = 0
            analytics.track(db, "pickup_completed", merchant_id=order.merchant_id, session_id=order.session_id, entity_type="order", entity_id=order.id)
            audit.record(db, actor=user.actor, actor_role=user.role, entity_type="order", entity_id=order.id, action="handed_off", trace_id=order.trace_id)
            resolve_alerts(db, merchant.id, "missed_pickup", order.id)
    if wrong:
        raise Unprocessable(f"That code doesn't match this order. {remaining} attempt(s) left.", code="wrong_pickup_code", details={"remaining": remaining})
    return order_detail(user, order_id)


# --------------------------------------------------------------------------- counter check-in

# The Today page's check-in box finds the order from what the customer shows: the pass's QR
# ("LASTCALL:LC-1058:4821"), an order number with its code ("1058 4821"), or the 4-digit code alone.
# Codes are only stored as per-order hashes, so a code on its own is checked against each of the
# shop's open orders. Because one box tries every order at once, misses are counted per shop and
# lock the box for a while; a manager can unlock it.
LOOKUP_MISSES = 5
LOOKUP_WINDOW = timedelta(minutes=10)
OPEN_FULFILLMENT = ("NEW", "PACKING", "READY")
_SCANNED = re.compile(r"^LASTCALL:(LC-\d+):(\d{4})$", re.IGNORECASE)
_NUMBER_AND_CODE = re.compile(r"^#?\s*(?:LC)?[-\s]?(\d{3,})\D+(\d{4})$", re.IGNORECASE)


def parse_counter_code(raw: str) -> tuple[str | None, str]:
    """(order number or None, 4-digit code) from a scan or what staff typed."""
    text = raw.strip()
    if match := _SCANNED.match(text):
        return match.group(1).upper(), match.group(2)
    if match := _NUMBER_AND_CODE.match(text):
        return f"LC-{match.group(1)}", match.group(2)
    digits = "".join(ch for ch in text if ch.isdigit())
    if len(digits) == 4 and not any(ch.isalpha() for ch in text):
        return None, digits
    raise Unprocessable("Scan the pickup pass, or type its 4-digit code.", code="bad_pickup_code")


def order_lines(db: Session, order: Order) -> list[dict[str, Any]]:
    return [{"name": line["name"], "qty": line["qty"], "line_total_minor": line.get("line_total_minor")} for line in _quote(db, order).item_lines]


def _lookup_state(db: Session, merchant_id: str) -> SystemState:
    key = f"pickup_lookup:{merchant_id}"
    db.execute(insert(SystemState).values(key=key, value={"misses": [], "locked_until": None}).on_conflict_do_nothing(index_elements=["key"]))
    return db.get(SystemState, key, with_for_update=True)


def _locked_until(state: SystemState, now: datetime) -> datetime | None:
    until = state.value.get("locked_until")
    if not until:
        return None
    at = datetime.fromisoformat(until.replace("Z", "+00:00"))
    return at if at > now else None


def _locked(merchant: Merchant, until: datetime) -> Conflict:
    return Conflict(f"Too many codes didn't match. Check-in is locked until {clock.display_time(until, merchant.timezone)}.",
                    code="lookup_locked", details={"locked_until": clock.iso(until)})


def lookup_pickup(user: StaffContext, raw: str) -> dict[str, Any]:
    number, code = parse_counter_code(raw)
    with transaction() as db:
        merchant = merchant_by_id(db, user.merchant_id)
        now = clock.now()
        state = _lookup_state(db, merchant.id)
        if until := _locked_until(state, now):
            raise _locked(merchant, until)
        query = select(Order).where(Order.merchant_id == merchant.id)
        if number:
            query = query.where(Order.order_number == number)
        else:
            day_start = clock.combine_local(clock.local_date(merchant.timezone), "00:00", merchant.timezone)
            query = query.where(Order.payment_status == "CAPTURED", Order.fulfillment_status.in_(OPEN_FULFILLMENT)
                                | ((Order.fulfillment_status == "PICKED_UP") & (Order.picked_up_at >= day_start)))
        found = [o for o in db.scalars(query.limit(500)).all() if verify_pickup_code(o.id, code, o.pickup_code_hash)]
        ready = sorted((o for o in found if o.payment_status == "CAPTURED" and o.fulfillment_status in OPEN_FULFILLMENT),
                       key=lambda o: (o.pickup_starts_at, o.order_number))
        if ready:
            state.value = {"misses": [], "locked_until": None}
            return {"code": code, "matches": [
                {**order_summary(db, o, merchant, now), "lines": order_lines(db, o), "pickup_locked": o.pickup_attempts >= MAX_PICKUP_ATTEMPTS}
                for o in ready
            ]}
        # A code that matches a finished order is a double scan, not a guess: say what happened and don't count it.
        if done := next((o for o in found if o.fulfillment_status == "PICKED_UP"), None):
            when = clock.display_time(done.picked_up_at, merchant.timezone) if done.picked_up_at else "earlier"
            raise Conflict(f"#{done.order_number} was already picked up at {when}.", code="already_picked_up")
        if other := next(iter(found), None):
            why = "was cancelled" if other.fulfillment_status == "CANCELLED" else "isn't paid yet"
            raise Conflict(f"#{other.order_number} {why}. Don't hand it over.", code="not_open")
        cutoff = now - LOOKUP_WINDOW
        misses = [m for m in state.value.get("misses", []) if datetime.fromisoformat(m.replace("Z", "+00:00")) > cutoff] + [clock.iso(now)]
        locked = now + LOOKUP_WINDOW if len(misses) >= LOOKUP_MISSES else None
        state.value = {"misses": [] if locked else misses, "locked_until": clock.iso(locked)}
        remaining = 0 if locked else LOOKUP_MISSES - len(misses)
        audit.record(db, actor=user.actor, actor_role=user.role, entity_type="merchant", entity_id=merchant.id,
                     action="pickup_lookup_locked" if locked else "pickup_lookup_missed", meta={"remaining": remaining})
    if locked:
        raise _locked(merchant, locked)
    raise Unprocessable(f"No open order uses {code}. {remaining} {'try' if remaining == 1 else 'tries'} left before check-in locks.",
                        code="no_pickup_match", details={"remaining": remaining})


def unlock_lookup(user: StaffContext) -> dict[str, Any]:
    with transaction() as db:
        state = _lookup_state(db, user.merchant_id)
        state.value = {"misses": [], "locked_until": None}
        audit.record(db, actor=user.actor, actor_role=user.role, entity_type="merchant", entity_id=user.merchant_id, action="pickup_lookup_unlocked")
    return {"locked": False}


# --------------------------------------------------------------------------- refunds



def decline_cancellation(user: StaffContext, order_id: str, reason: str) -> dict[str, Any]:
    with transaction() as db:
        order = db.get(Order, order_id, with_for_update=True)
        if order is None or order.merchant_id != user.merchant_id:
            raise NotFound("Order not found")
        if not (order.cancel_request and order.cancel_request.get("status") == "requested"):
            raise Conflict("There's no open cancellation request", code="no_request")
        order.cancel_request = {**order.cancel_request, "status": "declined", "decision_reason": reason[:300], "decided_at": clock.iso(clock.now()),
                                "decided_by": user.display_name}
        audit.record(db, actor=user.actor, actor_role=user.role, entity_type="order", entity_id=order.id, action="cancellation_declined",
                     meta={"reason": reason[:300]}, trace_id=order.trace_id)
        resolve_alerts(db, order.merchant_id, "cancellation_request", order.id)
    return order_detail(user, order_id)


def reply_support(user: StaffContext, request_id: str, reply: str) -> dict[str, Any]:
    reply = reply.strip()
    if not reply:
        raise Unprocessable("Write a reply", code="empty_reply")
    with transaction() as db:
        row = db.get(SupportRequest, request_id, with_for_update=True)
        order = db.get(Order, row.order_id) if row else None
        if row is None or order is None or order.merchant_id != user.merchant_id:
            raise NotFound("Message not found")
        row.staff_reply = reply[:1000]
        row.replied_by = user.display_name
        row.replied_at = clock.now()
        row.status = "replied"
        audit.record(db, actor=user.actor, actor_role=user.role, entity_type="support", entity_id=row.id, action="support_replied",
                     meta={"used_ai_draft": reply.strip() == (row.ai_draft or "").strip()}, trace_id=order.trace_id)
        resolve_alerts(db, order.merchant_id, "support_request", row.id)
        order_id = order.id
    return order_detail(user, order_id)


# --------------------------------------------------------------------------- overview (M01)
