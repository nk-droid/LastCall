"""OrderService: the customer's view of an order, pickup pass, cancellation and help requests."""

from __future__ import annotations

import io
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote_plus
from zoneinfo import ZoneInfo

import qrcode
import qrcode.image.svg
from sqlalchemy import select

from app import clock
from app.ai import prompts
from app.ai.provider import invoke_structured
from app.ai.sanitize import clean_customer_prose
from app.db import transaction
from app.errors import Conflict, Unprocessable
from app.ids import new_id
from app.models import AuditEvent, BundleQuote, Merchant, Order, PaymentAttempt, Refund, Reservation, SupportRequest
from app.money import format_money
from app.security import pickup_code
from app.services import audit, jobs
from app.services import reservations as rsv
from app.services.alerts import raise_alert
from app.services.catalog import merchant_by_id, merchant_ref, policy
from app.services.checkout import _order_access

PENDING_PAYMENT = {"CAPTURE_REQUESTED", "OUTCOME_UNKNOWN", "CAPTURE_PENDING"}
AWAITING_PAYMENT = {"QUOTED", "RESERVED", "APPROVAL_PENDING", "APPROVED"}


def _qr_svg(data: str) -> str:
    image = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2)
    buffer = io.BytesIO()
    image.save(buffer)
    return buffer.getvalue().decode()


def status_banner(order: Order) -> dict[str, str]:
    p, f, r = order.payment_status, order.fulfillment_status, order.refund_status
    if p == "CAPTURED":
        if f == "CANCELLED":
            if r == "COMPLETED":
                return {"key": "refunded", "tone": "neutral", "title": "Order cancelled and refunded", "detail": "PayPal confirmed your refund."}
            if r in ("REQUESTED", "PENDING", "OUTCOME_UNKNOWN"):
                return {"key": "refund_pending", "tone": "warning", "title": "Order cancelled · refund pending", "detail": "We'll show the refund as complete once PayPal confirms it."}
            return {"key": "cancelled", "tone": "neutral", "title": "Order cancelled", "detail": "Contact the shop if you have questions about your refund."}
        if f == "PICKED_UP":
            return {"key": "picked_up", "tone": "success", "title": "Picked up", "detail": "Enjoy! Your receipt is below."}
        if f == "READY":
            return {"key": "ready", "tone": "success", "title": "Ready for pickup", "detail": "Show your pickup code at the counter."}
        return {"key": "confirmed", "tone": "success", "title": "Order confirmed", "detail": "Payment verified with PayPal. We'll have it ready for your pickup window."}
    if p in PENDING_PAYMENT:
        return {"key": "pending", "tone": "warning", "title": "Confirming your payment with PayPal",
                "detail": "This can take a moment. Please don't pay again; we'll update this page automatically."}
    if p in AWAITING_PAYMENT:
        return {"key": "awaiting_payment", "tone": "neutral", "title": "Waiting for PayPal approval", "detail": "Finish checkout to place your order."}
    if p == "CAPTURE_FAILED":
        return {"key": "payment_failed", "tone": "danger", "title": "Payment didn't go through", "detail": "You have not been charged. You can try checkout again."}
    return {"key": "expired", "tone": "neutral", "title": "Checkout expired", "detail": "Your items were released and you were not charged."}


_CUSTOMER_ACTIONS = {
    "checkout_started": "Checkout started",
    "paypal_order_created": "PayPal checkout opened",
    "capture_requested": "You approved the payment in PayPal",
    "capture_outcome_unknown": "Confirming payment with PayPal",
    "capture_verified": "Payment verified with PayPal",
    "capture_pending": "PayPal is reviewing the payment",
    "fulfillment_packing": "The shop started packing your order",
    "fulfillment_ready": "Ready for pickup",
    "handed_off": "Picked up",
    "cancellation_requested": "You requested cancellation",
    "cancellation_declined": "The shop declined the cancellation",
    "order_cancelled": "Order cancelled",
    "refund_requested": "Refund requested with PayPal",
    "refund_completed": "PayPal confirmed the refund",
    "checkout_abandoned": "Checkout expired; items released",
}


def _timeline(db, order: Order) -> list[dict[str, Any]]:
    ids = [order.id] + [a.id for a in db.scalars(select(PaymentAttempt).where(PaymentAttempt.order_id == order.id)).all()]
    events = db.scalars(select(AuditEvent).where(AuditEvent.entity_id.in_(ids)).order_by(AuditEvent.timestamp, AuditEvent.id)).all()
    seen: set[str] = set()
    timeline = []
    for event in events:
        label = _CUSTOMER_ACTIONS.get(event.action)
        if label and event.action not in seen:
            seen.add(event.action)
            timeline.append({"at": clock.iso(event.timestamp), "label": label, "action": event.action})
    return timeline


def customer_view(db, order: Order, merchant: Merchant, now: datetime) -> dict[str, Any]:
    quote = db.get(BundleQuote, order.quote_id)
    attempt = db.scalar(select(PaymentAttempt).where(PaymentAttempt.order_id == order.id).order_by(PaymentAttempt.created_at.desc()).limit(1))
    refunds = db.scalars(select(Refund).where(Refund.order_id == order.id).order_by(Refund.created_at)).all()
    support = db.scalars(select(SupportRequest).where(SupportRequest.order_id == order.id).order_by(SupportRequest.created_at)).all()
    show_code = order.payment_status == "CAPTURED" and order.fulfillment_status in ("NEW", "PACKING", "READY")
    code = pickup_code(order.id, order.pickup_code_salt) if show_code else None
    cutoff_minutes = int(policy(merchant, "cancellation_cutoff_minutes", 60))
    allowed_until = order.pickup_starts_at - timedelta(minutes=cutoff_minutes)
    open_request = bool(order.cancel_request and order.cancel_request.get("status") == "requested")
    can_request = (order.payment_status == "CAPTURED" and order.fulfillment_status in ("NEW", "PACKING")
                   and now < allowed_until and not open_request and order.refund_status == "NONE")
    can_cancel_unpaid = order.payment_status in AWAITING_PAYMENT | {"CAPTURE_FAILED"} and order.fulfillment_status == "NEW"
    address = merchant.address or {}
    one_line = ", ".join(x for x in [address.get("line1"), address.get("city"), address.get("region"), address.get("postal_code")] if x)
    tz = merchant.timezone
    return {
        "id": order.id,
        "number": order.order_number,
        "status": status_banner(order),
        "payment_status": order.payment_status,
        "fulfillment_status": order.fulfillment_status,
        "refund_status": order.refund_status,
        "amount_minor": order.amount_minor,
        "currency": order.currency,
        "lines": quote.item_lines if quote else [],
        "totals": {
            "reference_minor": quote.subtotal_reference_minor, "subtotal_minor": quote.subtotal_minor, "discount_minor": quote.discount_minor,
            "tax_minor": quote.tax_minor, "fees_minor": quote.fees_minor, "total_minor": quote.amount_minor,
        } if quote else None,
        "customer": {"name": (order.customer_contact or {}).get("name")},
        "pickup": {
            "label": f"{clock.display_time(order.pickup_starts_at, tz)}–{clock.display_time(order.pickup_ends_at, tz)}",
            "date_label": order.pickup_starts_at.astimezone(ZoneInfo(tz)).strftime("%A, %B %-d"),
            "starts_at": clock.iso(order.pickup_starts_at),
            "ends_at": clock.iso(order.pickup_ends_at),
            "code": code,
            "qr_svg": _qr_svg(f"LASTCALL:{order.order_number}:{code}") if code else None,
            "instructions": policy(merchant, "pickup_instructions", ""),
            "what_to_bring": policy(merchant, "what_to_bring", ""),
            "address": one_line,
            "directions_url": f"https://www.openstreetmap.org/search?query={quote_plus(one_line)}",
            "expired": order.pickup_expired_at is not None,
        },
        "merchant": {**merchant_ref(merchant), "email": merchant.support_email},
        "payment": {
            "provider": "PayPal",
            "environment": attempt.environment if attempt else None,
            "paypal_order_id": attempt.paypal_order_id if attempt else None,
            "capture_id": attempt.capture_id if attempt else None,
            "captured_at": clock.iso(attempt.captured_at) if attempt else None,
            "state": attempt.state if attempt else None,
        },
        "cancellation": {
            "allowed_until": clock.iso(allowed_until),
            "allowed_until_label": clock.display_time(allowed_until, tz),
            "can_request": can_request,
            "can_cancel_unpaid": can_cancel_unpaid,
            "request": order.cancel_request,
            "policy_text": policy(merchant, "cancellation_policy_text", ""),
            "refund_policy_text": policy(merchant, "refund_policy_text", ""),
        },
        "refunds": [
            {"id": r.id, "amount_minor": r.amount_minor, "currency": r.currency, "state": r.state, "paypal_refund_id": r.paypal_refund_id,
             "created_at": clock.iso(r.created_at), "completed_at": clock.iso(r.completed_at)}
            for r in refunds
        ],
        "support": [
            {"id": s.id, "topic": s.topic, "message": s.message, "status": s.status, "staff_reply": s.staff_reply,
             "created_at": clock.iso(s.created_at), "replied_at": clock.iso(s.replied_at)}
            for s in support
        ],
        "timeline": _timeline(db, order),
        "created_at": clock.iso(order.created_at),
        "confirmed_at": clock.iso(order.confirmed_at),
        "trace_id": order.trace_id,
    }


def customer_orders(session_id: str | None, user_id: str | None) -> dict[str, Any]:
    """'My orders': a signed-in shopper's orders at every shop, or a guest's orders from this browser session."""
    with transaction() as db:
        if user_id:
            owner = Order.customer_user_id == user_id
        elif session_id:
            owner = (Order.session_id == session_id) & Order.customer_user_id.is_(None)
        else:
            return {"signed_in": False, "orders": [], "as_of": clock.iso(clock.now())}
        rows = db.scalars(select(Order).where(owner).order_by(Order.created_at.desc()).limit(50)).all()
        shops: dict[str, Merchant] = {}
        result = []
        for order in rows:
            shop = shops.get(order.merchant_id) or shops.setdefault(order.merchant_id, merchant_by_id(db, order.merchant_id))
            quote = db.get(BundleQuote, order.quote_id)
            lines = quote.item_lines if quote else []
            tz = shop.timezone
            result.append({
                "id": order.id,
                "number": order.order_number,
                "merchant": merchant_ref(shop),
                "status": status_banner(order),
                "payment_status": order.payment_status,
                "fulfillment_status": order.fulfillment_status,
                "refund_status": order.refund_status,
                "amount_minor": order.amount_minor,
                "currency": order.currency,
                "units": sum(int(line["qty"]) for line in lines),
                "item_names": [line["name"] for line in lines],
                "pickup": {
                    "label": f"{clock.display_time(order.pickup_starts_at, tz)}–{clock.display_time(order.pickup_ends_at, tz)}",
                    "date_label": order.pickup_starts_at.astimezone(ZoneInfo(tz)).strftime("%a, %b %-d"),
                    "starts_at": clock.iso(order.pickup_starts_at),
                },
                "active": order.payment_status == "CAPTURED" and order.fulfillment_status in ("NEW", "PACKING", "READY"),
                "created_at": clock.iso(order.created_at),
            })
        return {"signed_in": bool(user_id), "orders": result, "as_of": clock.iso(clock.now())}


def claim_guest_orders(user_id: str, session_id: str | None) -> int:
    """After signing in, orders placed as a guest in this browser move to the account."""
    if not session_id:
        return 0
    with transaction() as db:
        rows = db.scalars(select(Order).where(Order.session_id == session_id, Order.customer_user_id.is_(None)).with_for_update()).all()
        for order in rows:
            order.customer_user_id = user_id
            audit.record(db, actor=f"user:{user_id}", actor_role="customer", entity_type="order", entity_id=order.id, action="order_claimed")
        return len(rows)


def customer_view_by_id(order_id: str, *, session_id: str | None, access_token: str | None,
                user_id: str | None = None) -> dict[str, Any]:
    with transaction() as db:
        order = _order_access(db, order_id, session_id, access_token, user_id=user_id)
        return customer_view(db, order, merchant_by_id(db, order.merchant_id), clock.now())


def request_cancellation(order_id: str, reason: str, *, session_id: str | None, access_token: str | None,
                user_id: str | None = None) -> dict[str, Any]:
    with transaction() as db:
        order = _order_access(db, order_id, session_id, access_token, lock=True, user_id=user_id)
        merchant = merchant_by_id(db, order.merchant_id)
        now = clock.now()
        view = customer_view(db, order, merchant, now)
        if not view["cancellation"]["can_request"]:
            raise Conflict(
                f"Cancellation requests close {view['cancellation']['allowed_until_label']} on pickup day, or this order can't be cancelled now.",
                code="cancellation_not_allowed",
            )
        order.cancel_request = {"status": "requested", "reason": (reason or "")[:300], "requested_at": clock.iso(now)}
        audit.record(db, actor=audit.customer_actor(order.session_id), actor_role="customer", entity_type="order", entity_id=order.id,
                     action="cancellation_requested", meta={"reason": (reason or "")[:300]}, trace_id=order.trace_id)
        raise_alert(db, merchant.id, "cancellation_request", "order", order.id,
                                 f"{order.order_number} requested cancellation; review and refund if appropriate", severity="medium")
        return customer_view(db, order, merchant, now)


def cancel_unpaid(order_id: str, *, session_id: str | None, access_token: str | None,
                user_id: str | None = None) -> dict[str, Any]:
    """Customer abandons an order that was never paid: release the hold immediately."""
    with transaction() as db:
        order = _order_access(db, order_id, session_id, access_token, lock=True, user_id=user_id)
        merchant = merchant_by_id(db, order.merchant_id)
        now = clock.now()
        if order.payment_status in PENDING_PAYMENT:
            raise Conflict("We're still confirming your payment with PayPal; try again in a minute", code="payment_in_progress")
        if order.payment_status == "CAPTURED":
            raise Conflict("This order is paid; request a cancellation instead", code="order_paid")
        for attempt in db.scalars(select(PaymentAttempt).where(PaymentAttempt.order_id == order.id).with_for_update()).all():
            if attempt.state in ("CREATING", "APPROVAL_PENDING", "APPROVED", "CAPTURE_FAILED"):
                attempt.state = "VOIDED"
        res = db.get(Reservation, order.reservation_id, with_for_update=True)
        rsv.release(db, res, "customer_cancelled", now, actor=audit.customer_actor(order.session_id), role="customer")
        order.payment_status = "EXPIRED"
        order.fulfillment_status = "CANCELLED"
        order.cancelled_at = now
        audit.record(db, actor=audit.customer_actor(order.session_id), actor_role="customer", entity_type="order", entity_id=order.id,
                     action="order_cancelled", meta={"unpaid": True}, trace_id=order.trace_id)
        return customer_view(db, order, merchant, now)


def support_message(order_id: str, message: str, topic: str, *, session_id: str | None, access_token: str | None,
                user_id: str | None = None) -> dict[str, Any]:
    """Customer help request. L5 drafts a reply for staff; it has no authority over the order."""
    message = (message or "").strip()
    if not message:
        raise Unprocessable("Write a message for the shop", code="empty_message")
    with transaction() as db:
        order = _order_access(db, order_id, session_id, access_token, user_id=user_id)
        merchant = merchant_by_id(db, order.merchant_id)
        now = clock.now()
        view = customer_view(db, order, merchant, now)
        request_id = new_id("sup")
        db.add(SupportRequest(id=request_id, order_id=order.id, topic=topic[:40], message=message[:1000], status="open"))
        facts = {
            "order_number": order.order_number,
            "payment_status": order.payment_status,
            "fulfillment_status": order.fulfillment_status,
            "refund_status": order.refund_status,
            "pickup_window": f"{view['pickup']['date_label']} {view['pickup']['label']}",
            "items": [f"{line['qty']} {line['name']}" for line in view["lines"]],
            "total": format_money(order.amount_minor, order.currency),
            "cancellation_allowed": view["cancellation"]["can_request"],
            "cancellation_allowed_until": view["cancellation"]["allowed_until_label"],
        }
        policy_text = {"cancellation": view["cancellation"]["policy_text"], "refund": view["cancellation"]["refund_policy_text"],
                       "pickup": view["pickup"]["instructions"]}
    outcome = invoke_structured(
        task="L5_support",
        prompt_version=prompts.SUPPORT_PROMPT_VERSION,
        system=prompts.SUPPORT_SYSTEM,
        payload={"order": facts, "policy": policy_text, "customer_message": message[:1000]},
        output_model=prompts.AISupportDraft,
    )
    draft, source = _rules_support_draft(facts), "rules"
    if outcome.ok:
        cleaned = clean_customer_prose(outcome.data.reply, allowed_amounts={facts["total"]}, max_chars=650)
        if cleaned:
            draft, source = cleaned, "ai"
    with transaction() as db:
        row = db.get(SupportRequest, request_id, with_for_update=True)
        row.ai_draft = draft
        row.ai_draft_source = source
        row.ai_invocation_id = outcome.invocation_id
        order = db.get(Order, order_id)
        merchant = merchant_by_id(db, order.merchant_id)
        raise_alert(db, merchant.id, "support_request", "support", request_id, f"{facts['order_number']}: new customer message", severity="medium")
        return customer_view(db, order, merchant, clock.now())


def _rules_support_draft(facts: dict[str, Any]) -> str:
    lines = [f"Hi! Thanks for your message about order {facts['order_number']}."]
    if facts["fulfillment_status"] == "READY":
        lines.append("Your order is packed and ready for pickup.")
    else:
        lines.append(f"Your pickup window is {facts['pickup_window']}.")
    if facts["cancellation_allowed"]:
        lines.append(f"If you need to cancel, use Request cancellation on your pickup pass before {facts['cancellation_allowed_until']} and we'll review it.")
    lines.append("A member of our team will follow up here shortly.")
    return " ".join(lines)


def expire_unclaimed() -> dict[str, int]:
    """Missed pickups follow merchant policy. An order is never marked collected automatically."""
    flagged = 0
    with transaction() as db:
        for merchant in db.scalars(select(Merchant)).all():
            flagged += _expire_unclaimed_for(db, merchant)
    return {"flagged": flagged}


def _expire_unclaimed_for(db, merchant: Merchant) -> int:
    flagged = 0
    now = clock.now()
    grace = timedelta(minutes=int(policy(merchant, "no_show_grace_minutes", 30)))
    rule = policy(merchant, "no_show_policy", "hold_for_review")
    overdue = db.scalars(
        select(Order).where(
            Order.merchant_id == merchant.id,
            Order.payment_status == "CAPTURED",
            Order.fulfillment_status.in_(["NEW", "PACKING", "READY"]),
            Order.pickup_ends_at + grace <= now,
            Order.pickup_expired_at.is_(None),
        ).with_for_update(skip_locked=True)
    ).all()
    for order in overdue:
        order.pickup_expired_at = now
        flagged += 1
        raise_alert(db, merchant.id, "missed_pickup", "order", order.id,
                    f"{order.order_number} missed its pickup window. Policy: {rule.replace('_', ' ')}.", severity="high")
        audit.record(db, actor="system:worker", actor_role="system", entity_type="order", entity_id=order.id, action="pickup_window_expired",
                     meta={"policy": rule}, trace_id=order.trace_id)
        if rule == "auto_refund":
            jobs.enqueue("refunds.auto_no_show", {"order_id": order.id}, dedupe_key=f"no_show_refund:{order.id}", db=db)
    return flagged


def purge_contacts() -> dict[str, int]:
    """Data retention: drop customer contact details from finished orders after the retention window."""
    purged = 0
    with transaction() as db:
        for merchant in db.scalars(select(Merchant)).all():
            days = int(policy(merchant, "data_retention_days", 30))
            cutoff = clock.now() - timedelta(days=days)
            rows = db.scalars(
                select(Order).where(Order.merchant_id == merchant.id, Order.contact_purged_at.is_(None), Order.updated_at < cutoff,
                                    Order.fulfillment_status.in_(["PICKED_UP", "CANCELLED"])).with_for_update(skip_locked=True)
            ).all()
            for order in rows:
                order.customer_contact = {"name": "[removed after retention period]"}
                order.contact_purged_at = clock.now()
                purged += 1
    return {"purged": purged}


@jobs.handler("pickups.expire", every=60)
def _expire(_: dict[str, Any]) -> dict[str, Any]:
    return expire_unclaimed()


@jobs.handler("retention.purge", every=3600)
def _purge(_: dict[str, Any]) -> dict[str, Any]:
    return purge_contacts()
