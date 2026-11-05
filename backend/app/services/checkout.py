"""CheckoutService and PaymentReconciliationService.

Lifecycle (internal payment status on the order):
QUOTED -> RESERVED -> APPROVAL_PENDING -> APPROVED -> CAPTURE_REQUESTED ->
CAPTURE_PENDING | CAPTURED | CAPTURE_FAILED | OUTCOME_UNKNOWN   (EXPIRED if abandoned)
Fulfillment (NEW -> PACKING -> READY -> PICKED_UP, or CANCELLED) is a separate field.

Rules enforced here:
* The PayPal order is built from the server quote, never from browser-supplied amounts.
* The state change and its PayPal-Request-Id are committed before any PayPal call, and no
  database transaction is held open across a network call.
* "Paid" (CAPTURED) is set only from a verified capture whose amount matches the quote.
* A lost or failed response becomes OUTCOME_UNKNOWN and is resolved by looking up the original
  order/capture; a retry reuses the same PayPal-Request-Id, so it can never charge twice.
* A hold whose payment is in flight is never released without reconciling first.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app import clock
from app.config import settings
from app.db import transaction
from app.errors import Conflict, NotFound, ProviderError, QuoteInvalid, Unprocessable
from app.ids import new_id, new_request_id, new_token
from app.models import BundleQuote, Merchant, Order, PaymentAttempt, Reservation
from app.money import format_money, to_decimal_string
from app.observability import trace_id_var
from app.payments import get_client
from app.payments.base import PayPalError, PayPalOutcomeUnknown, extract_capture, order_amount, order_reference, trim
from app.payments.payee import payee_object
from app.security import pickup_code, pickup_code_hash, token_hash
from app.services import analytics, audit, jobs, substitution
from app.services import quotes as qs
from app.services import reservations as rsv
from app.services.alerts import raise_alert
from app.services.catalog import merchant_by_id, policy

log = logging.getLogger(__name__)

_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,}")
_PHONE = re.compile(r"\+?[\d\s().-]{7,20}")
STOCK_KINDS = {"sold_out", "insufficient_stock", "paused", "dietary", "cutoff", "price_changed"}
IN_FLIGHT_STATES = {"CAPTURE_REQUESTED", "OUTCOME_UNKNOWN", "CAPTURE_PENDING"}


class CustomerDetails(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    email: str | None = Field(default=None, max_length=160)
    phone: str | None = Field(default=None, max_length=32)

    @model_validator(mode="after")
    def _contact(self) -> CustomerDetails:
        self.name = self.name.strip()
        self.email = (self.email or "").strip() or None
        self.phone = (self.phone or "").strip() or None
        if not self.name:
            raise ValueError("Enter the name for the pickup order")
        if not self.email and not self.phone:
            raise ValueError("Add an email or phone number so the shop can reach you about pickup")
        if self.email and not _EMAIL.fullmatch(self.email):
            raise ValueError("Enter a valid email address")
        if self.phone and not _PHONE.fullmatch(self.phone):
            raise ValueError("Enter a valid phone number")
        return self


class StartCheckout(BaseModel):
    quote_id: str
    customer: CustomerDetails
    accept_policies: bool
    policy_version: int


def paypal_order_body(order: Order, quote: BundleQuote, attempt: PaymentAttempt, merchant: Merchant) -> dict[str, Any]:
    cur = quote.currency
    items = [
        {
            "name": line["name"][:127],
            "sku": line["sku"],
            "quantity": str(line["qty"]),
            "unit_amount": {"currency_code": cur, "value": to_decimal_string(line["unit_sale_minor"], cur)},
            "category": "PHYSICAL_GOODS",
            "description": f"Surplus pickup item, regular {format_money(line['unit_reference_minor'], cur)}"[:127],
        }
        for line in quote.item_lines
    ]
    breakdown: dict[str, Any] = {
        "item_total": {"currency_code": cur, "value": to_decimal_string(quote.subtotal_minor, cur)},
        "tax_total": {"currency_code": cur, "value": to_decimal_string(quote.tax_minor, cur)},
    }
    if quote.fees_minor:
        breakdown["handling"] = {"currency_code": cur, "value": to_decimal_string(quote.fees_minor, cur)}
    unit: dict[str, Any] = {}
    if (payee := payee_object(attempt.payee)) is not None:
        unit["payee"] = payee
    return {
        "intent": "CAPTURE",
        "purchase_units": [
            {
                **unit,
                "reference_id": order.id,
                "custom_id": quote.id,
                "invoice_id": f"{order.order_number}-{attempt.id[-8:]}",
                "description": f"{merchant.name} pickup order {order.order_number}"[:127],
                "amount": {"currency_code": cur, "value": to_decimal_string(quote.amount_minor, cur), "breakdown": breakdown},
                "items": items,
            }
        ],
        "payment_source": {
            "paypal": {
                "experience_context": {
                    "brand_name": (merchant.name if attempt.payee else settings().paypal_brand_name)[:127],
                    "shipping_preference": "NO_SHIPPING",
                    "user_action": "PAY_NOW",
                }
            }
        },
    }


def payout_payee(merchant: Merchant) -> dict[str, Any] | None:
    """The verified PayPal account a shop is paid into, as stored on new payment attempts."""
    paypal = merchant.paypal or {}
    if paypal.get("status") != "connected":
        return None
    return {"merchant_id": paypal["merchant_id"]} if paypal.get("merchant_id") else None


def _order_access(db: Session, order_id: str, session_id: str | None, access_token: str | None, lock: bool = False,
                  user_id: str | None = None) -> Order:
    query = select(Order).where(Order.id == order_id)
    if lock:
        query = query.with_for_update()
    order = db.scalar(query)
    if order is None:
        raise NotFound("Order not found", code="order_missing")
    if session_id and order.session_id == session_id:
        return order
    if access_token and token_hash(access_token) == order.access_token_hash:
        return order
    if user_id and order.customer_user_id == user_id:
        return order  # the same signed-in shopper, from another browser or device
    raise NotFound("Order not found", code="order_missing")


def start_checkout(session_id: str, req: StartCheckout, user_id: str | None = None) -> dict[str, Any]:
    """Create (or reuse) the order and a PayPal order for the current, held quote."""
    client = get_client()
    plaintext_token: str | None = None
    failure: list[dict[str, Any]] | None = None
    ready: dict[str, Any] | None = None
    with transaction() as db:
        if not req.accept_policies:
            raise Unprocessable("Please review and accept the pickup, cancellation and refund policy", code="policies_not_accepted")
        quote = qs.load_for_session(db, req.quote_id, session_id, lock=True)
        merchant = merchant_by_id(db, quote.merchant_id)
        if not merchant.is_live:
            raise Conflict(f"{merchant.name} isn't taking orders right now", code="shop_unavailable")
        if req.policy_version != merchant.policy_version:
            raise Conflict("The shop updated its policies; please review them again", code="policy_changed",
                           details={"policy_version": merchant.policy_version})
        now = clock.now()
        if quote.status not in ("ACTIVE", "CONVERTED"):
            raise Conflict("This basket is no longer current; review the latest version", code="quote_not_active", details={"status": quote.status})
        res = db.scalar(select(Reservation).where(Reservation.quote_id == quote.id).with_for_update())
        hold_ok = res is not None and (res.state == "PAYMENT_IN_FLIGHT" or (res.state == "HELD" and res.expires_at > now))
        if not hold_ok:
            if quote.expires_at <= now:
                raise Conflict("Your quote expired; refresh it to re-check prices and stock", code="quote_expired")
            acquired, problems = rsv.acquire(db, merchant=merchant, quote=quote, now=now, existing=res)
            if acquired is None:
                failure = [p.to_dict() for p in problems]
                quote.status = "INVALIDATED"
                quote.invalid_reason = failure
            res = acquired
        if failure is None:
            ready, body, attempt_id, request_id, order_id, plaintext_token = _prepare_order(db, merchant, quote, res, req, session_id, client, now,
                                                                                            user_id)
    if failure is not None:
        offer = substitution.offer_for_problems(session_id, req.quote_id)
        raise QuoteInvalid("Your basket changed before checkout", details={"problems": failure, "offer": offer})
    if ready is not None:
        return ready
    return _create_paypal_order(client, body, request_id, attempt_id, order_id, plaintext_token, quote.trace_id)


def _prepare_order(db: Session, merchant: Merchant, quote: BundleQuote, res: Reservation, req: StartCheckout, session_id: str,
                   client: Any, now: datetime, user_id: str | None) -> tuple[dict[str, Any] | None, dict[str, Any], str, str, str, str | None]:
    plaintext_token: str | None = None
    order = db.scalar(select(Order).where(Order.quote_id == quote.id).with_for_update())
    contact = req.customer.model_dump()
    if order is None:
        number = db.scalar(text("SELECT nextval('order_number_seq')"))
        plaintext_token = new_token()
        order_id = new_id("ord")
        salt = new_token(12)
        order = Order(
            id=order_id,
            order_number=f"LC-{number}",
            merchant_id=merchant.id,
            quote_id=quote.id,
            reservation_id=res.id,
            session_id=session_id,
            customer_user_id=user_id,
            customer_contact=contact,
            payment_status="RESERVED",
            fulfillment_status="NEW",
            refund_status="NONE",
            amount_minor=quote.amount_minor,
            currency=quote.currency,
            pickup_slot_id=quote.pickup_slot_id,
            pickup_starts_at=_parse(quote.pickup_slot_snapshot["starts_at"]),
            pickup_ends_at=_parse(quote.pickup_slot_snapshot["ends_at"]),
            pickup_code_salt=salt,
            pickup_code_hash=pickup_code_hash(order_id, pickup_code(order_id, salt)),
            access_token_hash=token_hash(plaintext_token),
            trace_id=quote.trace_id,
            created_at=now,  # the app clock, like the events that insights compare orders with
        )
        db.add(order)
        db.flush()
        analytics.track(db, "checkout_started", merchant_id=merchant.id, session_id=session_id, entity_type="order", entity_id=order.id,
                        properties={"amount_minor": quote.amount_minor})
    else:
        if order.payment_status in IN_FLIGHT_STATES | {"CAPTURED"}:
            raise Conflict("Payment for this order is already being processed", code="payment_in_progress",
                           details={"order_id": order.id, "payment_status": order.payment_status})
        order.customer_contact = contact
        order.reservation_id = res.id
        if order.payment_status == "EXPIRED" and order.fulfillment_status == "CANCELLED" and order.cancel_request is None:
            order.fulfillment_status = "NEW"  # buyer came back after the checkout was auto-abandoned
            order.cancelled_at = None

    attempt = db.scalar(
        select(PaymentAttempt).where(PaymentAttempt.order_id == order.id, PaymentAttempt.state.in_(["CREATING", "APPROVAL_PENDING", "APPROVED"]))
        .order_by(PaymentAttempt.created_at.desc()).limit(1).with_for_update()
    )
    if attempt is not None and attempt.state in ("APPROVAL_PENDING", "APPROVED") and attempt.amount_minor == quote.amount_minor and attempt.paypal_order_id:
        res.state = "PAYMENT_IN_FLIGHT"
        res.expires_at = max(res.expires_at, now + timedelta(seconds=int(policy(merchant, "payment_window_seconds", 900))))
        return _checkout_response(order, attempt, client.environment, plaintext_token), {}, attempt.id, attempt.request_id, order.id, plaintext_token
    if attempt is None or attempt.amount_minor != quote.amount_minor:
        if attempt is not None:
            attempt.state = "VOIDED"
        attempt = PaymentAttempt(
            id=new_id("pay"), order_id=order.id, quote_id=quote.id, environment=client.environment,
            request_id=new_request_id(), state="CREATING", amount_minor=quote.amount_minor, currency=quote.currency,
            payee=payout_payee(merchant),
        )
        db.add(attempt)
    res.state = "PAYMENT_IN_FLIGHT"
    res.expires_at = max(res.expires_at, now + timedelta(seconds=int(policy(merchant, "payment_window_seconds", 900))))
    audit.record(db, actor=audit.customer_actor(session_id), actor_role="customer", entity_type="order", entity_id=order.id,
                 action="checkout_started", meta={"payment_attempt_id": attempt.id, "amount_minor": attempt.amount_minor}, trace_id=order.trace_id)
    body = paypal_order_body(order, quote, attempt, merchant)
    return None, body, attempt.id, attempt.request_id, order.id, plaintext_token


def _create_paypal_order(client: Any, body: dict[str, Any], request_id: str, attempt_id: str, order_id: str,
                         plaintext_token: str | None, trace_id: str) -> dict[str, Any]:
    trace_id_var.set(trace_id)
    try:
        created = client.create_order(body, request_id)
    except PayPalOutcomeUnknown as exc:
        _note_attempt_error(attempt_id, {"kind": "outcome_unknown", "detail": str(exc)})
        raise ProviderError("PayPal didn't respond in time. Please try again; you won't be charged twice.", code="paypal_unavailable") from exc
    except PayPalError as exc:
        _note_attempt_error(attempt_id, exc.to_dict(), state="CAPTURE_FAILED" if exc.status == 422 else None)
        raise ProviderError("PayPal couldn't start checkout for this order.", code="paypal_create_failed", details=exc.to_dict()) from exc

    with transaction() as db:
        attempt = db.get(PaymentAttempt, attempt_id, with_for_update=True)
        order = db.get(Order, order_id, with_for_update=True)
        if attempt.paypal_order_id is None:
            attempt.paypal_order_id = created["id"]
            attempt.provider_state = created.get("status")
            attempt.create_response = trim(created)
            attempt.last_error = None
        if attempt.state == "CREATING":
            attempt.state = "APPROVAL_PENDING"
        if order.payment_status in ("RESERVED", "QUOTED", "CAPTURE_FAILED", "EXPIRED"):
            order.payment_status = "APPROVAL_PENDING"
        audit.record(db, actor="provider:paypal", actor_role="system", entity_type="payment_attempt", entity_id=attempt.id,
                     action="paypal_order_created", meta={"paypal_order_id": attempt.paypal_order_id, "request_id": attempt.request_id,
                                                          "environment": attempt.environment}, trace_id=order.trace_id)
        return _checkout_response(order, attempt, attempt.environment, plaintext_token)


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _checkout_response(order: Order, attempt: PaymentAttempt, environment: str, token: str | None) -> dict[str, Any]:
    return {
        "order_id": order.id,
        "order_number": order.order_number,
        "paypal_order_id": attempt.paypal_order_id,
        "payment_attempt_id": attempt.id,
        "amount_minor": attempt.amount_minor,
        "currency": attempt.currency,
        "environment": environment,
        "access_token": token,
        "payment_status": order.payment_status,
    }


def _note_attempt_error(attempt_id: str, error: dict[str, Any], state: str | None = None) -> None:
    with transaction() as db:
        attempt = db.get(PaymentAttempt, attempt_id, with_for_update=True)
        if attempt is None:
            return
        attempt.last_error = error
        if state:
            attempt.state = state


# --------------------------------------------------------------------------- capture


def capture(order_id: str, paypal_order_id: str, *, session_id: str | None, access_token: str | None,
            user_id: str | None = None) -> dict[str, Any]:
    from app.services import orders  # noqa: PLC0415 - orders imports this module

    client = get_client()
    with transaction() as db:
        order = _order_access(db, order_id, session_id, access_token, user_id=user_id)
        attempt = db.scalar(select(PaymentAttempt).where(PaymentAttempt.paypal_order_id == paypal_order_id, PaymentAttempt.order_id == order.id))
        if attempt is None:
            raise NotFound("Payment not found for this order", code="payment_missing")
        state, attempt_id, trace = attempt.state, attempt.id, order.trace_id
    trace_id_var.set(trace)
    if state == "CAPTURED":
        return orders.customer_view_by_id(order_id, session_id=session_id, access_token=access_token, user_id=user_id)
    if state in IN_FLIGHT_STATES:
        reconcile_attempt(attempt_id, reason="customer_retry")
        return orders.customer_view_by_id(order_id, session_id=session_id, access_token=access_token, user_id=user_id)
    if state == "VOIDED":
        raise Conflict("This payment was replaced by a newer checkout", code="payment_voided")

    # Verify approval and the exact amount with PayPal before capturing.
    try:
        provider_order = client.get_order(paypal_order_id)
    except PayPalOutcomeUnknown as exc:
        raise ProviderError("We couldn't reach PayPal to confirm your approval. Please try again.", code="paypal_unavailable") from exc
    except PayPalError as exc:
        raise ProviderError("PayPal couldn't find this payment.", code="paypal_lookup_failed", details=exc.to_dict()) from exc
    if provider_order.get("status") == "COMPLETED":
        apply_capture_result(attempt_id, provider_order, source="provider_lookup")
        return orders.customer_view_by_id(order_id, session_id=session_id, access_token=access_token, user_id=user_id)
    if provider_order.get("status") != "APPROVED":
        raise Conflict("PayPal hasn't recorded your approval yet", code="not_approved", details={"provider_status": provider_order.get("status")})

    reacquire_failed: list[dict[str, Any]] | None = None
    mismatch = False
    with transaction() as db:
        attempt = db.get(PaymentAttempt, attempt_id, with_for_update=True)
        order = db.get(Order, attempt.order_id, with_for_update=True)
        merchant = merchant_by_id(db, order.merchant_id)
        quote = db.get(BundleQuote, attempt.quote_id, with_for_update=True)
        now = clock.now()
        if attempt.state in IN_FLIGHT_STATES | {"CAPTURED"}:
            pass  # a concurrent request got here first; fall through to reconciliation below
        else:
            value, currency = order_amount(provider_order)
            if value != to_decimal_string(attempt.amount_minor, attempt.currency) or currency != attempt.currency or order_reference(provider_order) != order.id:
                attempt.state = "CAPTURE_FAILED"
                attempt.last_error = {"kind": "amount_mismatch", "provider_amount": value, "provider_currency": currency}
                order.payment_status = "CAPTURE_FAILED"
                audit.record(db, actor="system:checkout", actor_role="system", entity_type="payment_attempt", entity_id=attempt.id,
                             action="capture_refused_amount_mismatch", meta=attempt.last_error, trace_id=order.trace_id)
                mismatch = True
            elif quote.status not in ("ACTIVE", "CONVERTED") or quote.amount_minor != attempt.amount_minor:
                raise Conflict("Your basket changed; please approve the new total", code="quote_changed")
            if not mismatch:
                _revive_and_request_capture(db, merchant, attempt, order, quote, now)
        state_now, capture_request_id = attempt.state, attempt.capture_request_id
        reacquire_failed = attempt.last_error.get("reacquire_failed") if (attempt.state == "EXPIRED" and attempt.last_error) else None
    if mismatch:
        raise Conflict("The approved amount doesn't match your order, so we did not capture it.", code="amount_mismatch")
    if reacquire_failed is not None:
        offer = substitution.offer_for_problems(order.session_id, attempt.quote_id) if order.session_id == session_id else None
        raise QuoteInvalid("Your hold expired and an item is no longer available. You have not been charged.",
                           details={"problems": reacquire_failed, "offer": offer})
    if state_now != "CAPTURE_REQUESTED" or capture_request_id is None:
        reconcile_attempt(attempt_id, reason="concurrent_capture")
        return orders.customer_view_by_id(order_id, session_id=session_id, access_token=access_token, user_id=user_id)
    return _do_capture(client, attempt_id, paypal_order_id, capture_request_id, order_id, session_id, access_token, user_id)


def _revive_and_request_capture(db: Session, merchant: Merchant, attempt: PaymentAttempt, order: Order, quote: BundleQuote, now: datetime) -> None:
    """Mark CAPTURE_REQUESTED (durably, before calling PayPal), re-acquiring a lapsed hold first."""
    res = db.get(Reservation, order.reservation_id, with_for_update=True)
    if res.state == "RELEASED" or (res.state == "HELD" and res.expires_at <= now):
        reacquired, problems = rsv.acquire(db, merchant=merchant, quote=quote, now=now, existing=res, check_prices=False, enforce_slot_rules=False)
        if reacquired is None:
            attempt.state = "EXPIRED"
            order.payment_status = "EXPIRED"
            quote.status = "INVALIDATED"
            quote.invalid_reason = [p.to_dict() for p in problems]
            attempt.last_error = {"kind": "abandoned", "reacquire_failed": quote.invalid_reason}
            return
    if order.payment_status == "EXPIRED" and order.fulfillment_status == "CANCELLED" and order.cancel_request is None:
        order.fulfillment_status = "NEW"  # buyer returned after the checkout was auto-abandoned
        order.cancelled_at = None
    res.state = "PAYMENT_IN_FLIGHT"
    res.expires_at = max(res.expires_at, now + timedelta(seconds=int(policy(merchant, "payment_window_seconds", 900))))
    if attempt.approved_at is None:
        attempt.approved_at = now
        analytics.track(db, "paypal_approved", merchant_id=order.merchant_id, session_id=order.session_id, entity_type="order", entity_id=order.id)
    attempt.state = "CAPTURE_REQUESTED"
    attempt.capture_request_id = attempt.capture_request_id or new_request_id()
    attempt.capture_requested_at = now
    order.payment_status = "CAPTURE_REQUESTED"
    audit.record(db, actor=audit.customer_actor(order.session_id), actor_role="customer", entity_type="payment_attempt", entity_id=attempt.id,
                 action="capture_requested", meta={"paypal_order_id": attempt.paypal_order_id, "capture_request_id": attempt.capture_request_id},
                 trace_id=order.trace_id)


def _do_capture(client: Any, attempt_id: str, paypal_order_id: str, capture_request_id: str, order_id: str,
                session_id: str | None, access_token: str | None, user_id: str | None = None) -> dict[str, Any]:
    from app.services import orders  # noqa: PLC0415 - orders imports this module

    try:
        captured = client.capture_order(paypal_order_id, capture_request_id)
    except PayPalOutcomeUnknown as exc:
        _mark_outcome_unknown(attempt_id, str(exc))
        return orders.customer_view_by_id(order_id, session_id=session_id, access_token=access_token, user_id=user_id)
    except PayPalError as exc:
        if exc.issue == "ORDER_ALREADY_CAPTURED":
            reconcile_attempt(attempt_id, reason="already_captured")
            return orders.customer_view_by_id(order_id, session_id=session_id, access_token=access_token, user_id=user_id)
        _mark_capture_error(attempt_id, exc)
        view = orders.customer_view_by_id(order_id, session_id=session_id, access_token=access_token, user_id=user_id)
        view["capture_error"] = {"issue": exc.issue, "restart": exc.issue == "INSTRUMENT_DECLINED",
                                 "message": "Your payment method was declined. Choose another way to pay in PayPal."
                                 if exc.issue == "INSTRUMENT_DECLINED" else "PayPal couldn't complete the payment. You have not been charged."}
        return view
    apply_capture_result(attempt_id, captured, source="capture_response")
    return orders.customer_view_by_id(order_id, session_id=session_id, access_token=access_token, user_id=user_id)


def _mark_outcome_unknown(attempt_id: str, detail: str) -> None:
    with transaction() as db:
        attempt = db.get(PaymentAttempt, attempt_id, with_for_update=True)
        order = db.get(Order, attempt.order_id, with_for_update=True)
        if attempt.state == "CAPTURED":
            return
        attempt.state = "OUTCOME_UNKNOWN"
        attempt.last_error = {"kind": "outcome_unknown", "detail": detail}
        order.payment_status = "OUTCOME_UNKNOWN"
        audit.record(db, actor="system:checkout", actor_role="system", entity_type="payment_attempt", entity_id=attempt.id,
                     action="capture_outcome_unknown", meta={"detail": detail}, trace_id=order.trace_id)
        jobs.enqueue("payments.reconcile", {"attempt_id": attempt.id}, delay_seconds=2, dedupe_key=f"reconcile:{attempt.id}", db=db)


def _mark_capture_error(attempt_id: str, exc: PayPalError) -> None:
    with transaction() as db:
        attempt = db.get(PaymentAttempt, attempt_id, with_for_update=True)
        order = db.get(Order, attempt.order_id, with_for_update=True)
        if attempt.state == "CAPTURED":
            return
        attempt.last_error = exc.to_dict()
        if exc.issue == "INSTRUMENT_DECLINED":
            attempt.state = "APPROVAL_PENDING"  # buyer picks another funding source; same PayPal order
            order.payment_status = "APPROVAL_PENDING"
        else:
            attempt.state = "CAPTURE_FAILED"
            order.payment_status = "CAPTURE_FAILED"
        audit.record(db, actor="provider:paypal", actor_role="system", entity_type="payment_attempt", entity_id=attempt.id,
                     action="capture_failed", meta=exc.to_dict(), trace_id=order.trace_id)


def apply_capture_result(attempt_id: str, provider_payload: dict[str, Any], *, source: str) -> str:
    """Record a capture seen in a provider response. Idempotent; only a verified, amount-matching
    COMPLETED capture marks the order paid and converts the hold into an allocation."""
    capture = extract_capture(provider_payload) if "purchase_units" in provider_payload else provider_payload
    with transaction() as db:
        attempt = db.get(PaymentAttempt, attempt_id, with_for_update=True)
        order = db.get(Order, attempt.order_id, with_for_update=True)
        merchant = merchant_by_id(db, order.merchant_id)
        now = clock.now()
        if attempt.state == "CAPTURED":
            return "already_captured"
        if not capture:
            return "no_capture"
        amount = capture.get("amount") or {}
        if amount.get("value") != to_decimal_string(attempt.amount_minor, attempt.currency) or amount.get("currency_code") != attempt.currency:
            attempt.state = "OUTCOME_UNKNOWN"
            order.payment_status = "OUTCOME_UNKNOWN"
            attempt.last_error = {"kind": "captured_amount_mismatch", "amount": amount}
            _alert(db, order, "payment_mismatch", f"{order.order_number}: captured amount {amount} differs from the quote; review in PayPal")
            return "amount_mismatch"
        status = capture.get("status")
        attempt.capture_id = capture.get("id")
        attempt.provider_state = status
        attempt.capture_response = trim(provider_payload)
        if status in ("COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"):
            attempt.state = "CAPTURED"
            attempt.captured_amount_minor = attempt.amount_minor
            attempt.captured_at = now
            order.payment_status = "CAPTURED"
            order.confirmed_at = order.confirmed_at or now
            quote = db.get(BundleQuote, attempt.quote_id, with_for_update=True)
            quote.status = "CONVERTED"
            res = db.get(Reservation, order.reservation_id, with_for_update=True)
            issues = rsv.commit(db, res, merchant, now)
            if issues:
                order.exception_flags = sorted(set([*order.exception_flags, "stock_shortage_after_capture"]))
                _alert(db, order, "stock_shortage", f"{order.order_number} was paid but stock is short: {'; '.join(issues)}. Offer a substitute or refund.")
            analytics.track(db, "capture_verified", merchant_id=order.merchant_id, session_id=order.session_id, entity_type="order", entity_id=order.id,
                            properties={"amount_minor": attempt.amount_minor, "source": source})
            audit.record(db, actor="provider:paypal", actor_role="system", entity_type="payment_attempt", entity_id=attempt.id,
                         action="capture_verified", meta={"capture_id": attempt.capture_id, "source": source, "amount_minor": attempt.amount_minor},
                         trace_id=order.trace_id)
            return "captured"
        if status == "PENDING":
            attempt.state = "CAPTURE_PENDING"
            order.payment_status = "CAPTURE_PENDING"
            audit.record(db, actor="provider:paypal", actor_role="system", entity_type="payment_attempt", entity_id=attempt.id,
                         action="capture_pending", meta={"capture_id": attempt.capture_id, "reason": (capture.get("status_details") or {}).get("reason")},
                         trace_id=order.trace_id)
            jobs.enqueue("payments.reconcile", {"attempt_id": attempt.id}, delay_seconds=15, dedupe_key=f"reconcile:{attempt.id}", db=db)
            return "pending"
        attempt.state = "CAPTURE_FAILED"
        order.payment_status = "CAPTURE_FAILED"
        res = db.get(Reservation, order.reservation_id, with_for_update=True)
        rsv.release(db, res, "capture_failed", now)
        audit.record(db, actor="provider:paypal", actor_role="system", entity_type="payment_attempt", entity_id=attempt.id,
                     action="capture_declined", meta={"status": status}, trace_id=order.trace_id)
        return "failed"


def _alert(db: Session, order: Order, kind: str, message: str) -> None:
    raise_alert(db, order.merchant_id, kind, "order", order.id, message, severity="high")


# --------------------------------------------------------------------------- reconciliation


def reconcile_attempt(attempt_id: str, *, reason: str) -> str:
    """Resolve a payment attempt against PayPal's record of it. Safe to run any number of times."""
    client = get_client()
    with transaction() as db:
        attempt = db.get(PaymentAttempt, attempt_id)
        if attempt is None:
            return "missing"
        attempt.reconcile_count += 1
        state, paypal_order_id, capture_request_id = attempt.state, attempt.paypal_order_id, attempt.capture_request_id
        order = db.get(Order, attempt.order_id)
        res = db.get(Reservation, order.reservation_id)
        hold_expired = res.expires_at <= clock.now()
        trace_id_var.set(order.trace_id)
    if state in ("CAPTURED", "VOIDED", "EXPIRED"):
        return state.lower()
    if paypal_order_id is None:
        if hold_expired:
            _abandon(attempt_id, "PayPal order was never created")
            return "abandoned"
        return "waiting"
    try:
        provider_order = client.get_order(paypal_order_id)
    except PayPalOutcomeUnknown as exc:
        raise jobs.RetryLater(str(exc)) from exc
    except PayPalError as exc:
        if exc.status == 404:
            _abandon(attempt_id, "PayPal order not found")
            return "abandoned"
        raise
    status = provider_order.get("status")
    if extract_capture(provider_order):
        return apply_capture_result(attempt_id, provider_order, source=f"reconciliation:{reason}")
    if status == "APPROVED" and state in ("CAPTURE_REQUESTED", "OUTCOME_UNKNOWN") and capture_request_id:
        # Our capture never landed; retrying with the same PayPal-Request-Id cannot double-charge.
        try:
            captured = client.capture_order(paypal_order_id, capture_request_id)
        except PayPalOutcomeUnknown as exc:
            raise jobs.RetryLater(str(exc)) from exc
        except PayPalError as exc:
            if exc.issue == "ORDER_ALREADY_CAPTURED":
                return apply_capture_result(attempt_id, client.get_order(paypal_order_id), source="reconciliation:already_captured")
            _mark_capture_error(attempt_id, exc)
            return "capture_failed"
        return apply_capture_result(attempt_id, captured, source=f"reconciliation_retry:{reason}")
    if status == "APPROVED":
        _mark_approved(attempt_id)
        if hold_expired:
            _abandon(attempt_id, "Approved but never captured before the hold expired")
            return "abandoned"
        return "approved"
    if status in ("CREATED", "PAYER_ACTION_REQUIRED", "SAVED") and hold_expired:
        _abandon(attempt_id, "Buyer did not approve before the hold expired")
        return "abandoned"
    if status == "VOIDED":
        _abandon(attempt_id, "PayPal order voided", attempt_state="VOIDED")
        return "voided"
    return "waiting"


def _mark_approved(attempt_id: str) -> None:
    with transaction() as db:
        attempt = db.get(PaymentAttempt, attempt_id, with_for_update=True)
        if attempt.state == "APPROVAL_PENDING":
            attempt.state = "APPROVED"
            attempt.approved_at = attempt.approved_at or clock.now()
            order = db.get(Order, attempt.order_id, with_for_update=True)
            if order.payment_status == "APPROVAL_PENDING":
                order.payment_status = "APPROVED"


def _abandon(attempt_id: str, why: str, attempt_state: str = "EXPIRED") -> None:
    """Release stock for a checkout that never completed (only from pre-capture states)."""
    with transaction() as db:
        attempt = db.get(PaymentAttempt, attempt_id, with_for_update=True)
        if attempt.state not in ("CREATING", "APPROVAL_PENDING", "APPROVED", "CAPTURE_FAILED"):
            return  # moved on (e.g. capture requested) since we looked; never release in-flight money
        order = db.get(Order, attempt.order_id, with_for_update=True)
        res = db.get(Reservation, order.reservation_id, with_for_update=True)
        now = clock.now()
        attempt.state = attempt_state
        attempt.last_error = {"kind": "abandoned", "detail": why}
        if order.payment_status not in ("CAPTURED",):
            order.payment_status = "EXPIRED"
            if order.fulfillment_status == "NEW":
                order.fulfillment_status = "CANCELLED"
                order.cancelled_at = now
        rsv.release(db, res, "abandoned", now)
        audit.record(db, actor="system:reconciler", actor_role="system", entity_type="payment_attempt", entity_id=attempt.id,
                     action="checkout_abandoned", meta={"why": why}, trace_id=order.trace_id)


def sweep_in_flight() -> dict[str, int]:
    """Holds whose payment is in flight are never released blindly: queue reconciliation instead."""
    now = clock.now()
    released = queued = 0
    with transaction() as db:
        in_flight = db.scalars(select(Reservation).where(Reservation.state == "PAYMENT_IN_FLIGHT", Reservation.expires_at <= now).limit(200)).all()
        for res in in_flight:
            order = db.scalar(select(Order).where(Order.reservation_id == res.id))
            if order is None:
                rsv.release(db, res, "expired", now)
                released += 1
                continue
            attempt = db.scalar(select(PaymentAttempt).where(PaymentAttempt.order_id == order.id).order_by(PaymentAttempt.created_at.desc()).limit(1))
            if attempt is not None:
                jobs.enqueue("payments.reconcile", {"attempt_id": attempt.id, "reason": "hold_expired"}, dedupe_key=f"reconcile:{attempt.id}", db=db)
                queued += 1
    return {"released": released, "reconcile_queued": queued}


def reconcile_unknown() -> int:
    """Belt and braces: queue reconciliation for any attempt stuck in an uncertain state."""
    count = 0
    with transaction() as db:
        stuck = db.scalars(select(PaymentAttempt).where(PaymentAttempt.state.in_(list(IN_FLIGHT_STATES)))).all()
        for attempt in stuck:
            jobs.enqueue("payments.reconcile", {"attempt_id": attempt.id, "reason": "periodic"}, dedupe_key=f"reconcile:{attempt.id}", db=db)
            count += 1
    return count


@jobs.handler("payments.sweep", every=15)
def _sweep(_: dict[str, Any]) -> dict[str, Any]:
    result = sweep_in_flight()
    result["reconcile_unknown"] = reconcile_unknown()
    return result


@jobs.handler("payments.reconcile")
def _reconcile(payload: dict[str, Any]) -> dict[str, Any]:
    return {"result": reconcile_attempt(payload["attempt_id"], reason=payload.get("reason", "job"))}
