"""LastCall's revenue: a commission on each paid order, billed to the shop weekly by PayPal invoice.

Shoppers pay the shop's price and nothing more, straight to the shop's PayPal account. When PayPal confirms a capture,
the order's fee is recorded under the terms in force then (by default 10% of the items at their surplus price, at least
$0.25, never more than the items themselves). A refund recalculates it on what the shop kept; a full refund waives it.

Every week (or on demand from Platform ops) each shop with fees due gets one invoice from LastCall through PayPal
Invoicing v2: a line per order, and fees refunded after an earlier invoice taken off as a discount. Invoices are created
and sent with PayPal-Request-Ids, so a retry never bills twice. Payment is recorded from INVOICING.INVOICE.* webhooks,
with a periodic status check as the fallback; a cancelled invoice puts its fees back to be billed again.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.config import settings
from app.db import transaction
from app.ids import new_id, new_request_id
from app.models import BundleQuote, FeeInvoice, Membership, Merchant, Order, PlatformFee, Refund, User
from app.money import format_money, to_decimal_string
from app.payments import get_client
from app.payments.base import PayPalError, PayPalOutcomeUnknown
from app.services import audit, jobs

log = logging.getLogger(__name__)

OPEN = ("CREATING", "SENDING", "DRAFT", "SENT", "UNPAID", "PARTIALLY_PAID")
PAID = ("PAID", "MARKED_AS_PAID")
MAX_LINES = 100  # PayPal's limit on invoice items


# --------------------------------------------------------------------------- terms and the fee on one order


def terms() -> dict[str, Any]:
    s = settings()
    return {"rate_bps": s.platform_fee_bps, "min_minor": s.platform_fee_min_minor, "label": _terms_label(s.platform_fee_bps, s.platform_fee_min_minor, "USD")}


def _terms_label(rate_bps: int, min_minor: int, currency: str) -> str:
    return f"{Decimal(rate_bps) / 100:g}% of each order's items (min {format_money(min_minor, currency)})"


def fee_for(basis_minor: int, rate_bps: int, min_minor: int) -> int:
    """The commission on ``basis_minor`` of items: the rate, at least the minimum, never more than the items."""
    if basis_minor <= 0:
        return 0
    return min(basis_minor, max(min_minor, (basis_minor * rate_bps + 5000) // 10000))


def accrue(db: Session, order: Order, quote: BundleQuote, now: datetime) -> PlatformFee:
    """Record the order's fee once PayPal has confirmed its capture (idempotent: a replayed capture changes nothing)."""
    existing = db.scalar(select(PlatformFee).where(PlatformFee.order_id == order.id))
    if existing is not None:
        return existing
    s = settings()
    fee = PlatformFee(id=new_id("fee"), merchant_id=order.merchant_id, order_id=order.id, currency=order.currency, basis_minor=quote.subtotal_minor,
                      rate_bps=s.platform_fee_bps, min_minor=s.platform_fee_min_minor,
                      fee_minor=fee_for(quote.subtotal_minor, s.platform_fee_bps, s.platform_fee_min_minor), billed_minor=0, accrued_at=now)
    db.add(fee)
    db.flush()
    return fee


def adjust(db: Session, order: Order) -> PlatformFee | None:
    """After a refund completes: the fee on what the shop kept (items pro rata to the money kept), nothing after a full refund."""
    fee = db.scalar(select(PlatformFee).where(PlatformFee.order_id == order.id).with_for_update())
    if fee is None:
        return None
    quote = db.get(BundleQuote, order.quote_id)
    refunded = db.scalar(select(func.coalesce(func.sum(Refund.amount_minor), 0)).where(Refund.order_id == order.id, Refund.state == "COMPLETED")) or 0
    kept = max(0, order.amount_minor - refunded)
    fee.basis_minor = quote.subtotal_minor * kept // order.amount_minor if order.amount_minor else 0
    fee.fee_minor = fee_for(fee.basis_minor, fee.rate_bps, fee.min_minor)
    return fee


def order_fee(db: Session, order: Order) -> dict[str, Any] | None:
    """What the shop sees on an order: LastCall's fee and what it keeps."""
    fee = db.scalar(select(PlatformFee).where(PlatformFee.order_id == order.id))
    if fee is None:
        return None
    refunded = db.scalar(select(func.coalesce(func.sum(Refund.amount_minor), 0)).where(Refund.order_id == order.id, Refund.state == "COMPLETED")) or 0
    return {"fee_minor": fee.fee_minor, "net_minor": order.amount_minor - refunded - fee.fee_minor, "currency": fee.currency,
            "label": _terms_label(fee.rate_bps, fee.min_minor, fee.currency), "billed": fee.billed_minor > 0}


# --------------------------------------------------------------------------- weekly invoices


def period_end(merchant: Merchant, now: datetime) -> datetime:
    """Monday 00:00 of this week in the shop's timezone: invoices cover fees from before it."""
    local = now.astimezone(ZoneInfo(merchant.timezone))
    monday = (local - timedelta(days=local.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return monday.astimezone(ZoneInfo("UTC"))


@jobs.handler("fees.invoice", every=3600)
def _weekly(_: dict[str, Any]) -> dict[str, Any]:
    return bill_all(actor="system:weekly")


def bill_all(*, until: datetime | None = None, actor: str) -> dict[str, Any]:
    """Invoice every shop with fees due before ``until`` (default: the start of this week in each shop's timezone)."""
    now = clock.now()
    with transaction() as db:
        due = db.execute(select(PlatformFee.merchant_id).where(PlatformFee.fee_minor != PlatformFee.billed_minor, PlatformFee.invoice_id.is_(None))
                         .group_by(PlatformFee.merchant_id)).scalars().all()
        merchants = {m.id: m for m in db.scalars(select(Merchant).where(Merchant.id.in_(due))).all()} if due else {}
        for m in merchants.values():
            db.expunge(m)
    results = {"sent": 0, "skipped": 0, "failed": 0}
    for merchant in merchants.values():
        outcome = bill(merchant, until or period_end(merchant, now), actor=actor)
        results[outcome if outcome in results else "skipped"] += 1
    return results


def bill(merchant: Merchant, until: datetime, *, actor: str) -> str:
    """One invoice for the shop's fees accrued before ``until``: charges per order, earlier over-billing as a discount."""
    with transaction() as db:
        rows = db.scalars(select(PlatformFee).where(PlatformFee.merchant_id == merchant.id, PlatformFee.accrued_at < until,
                                                    PlatformFee.fee_minor != PlatformFee.billed_minor, PlatformFee.invoice_id.is_(None))
                          .order_by(PlatformFee.accrued_at).with_for_update()).all()
        numbers = dict(db.execute(select(Order.id, Order.order_number).where(Order.id.in_([r.order_id for r in rows]))).tuples().all()) if rows else {}
        lines = [{"fee_id": r.id, "order_number": numbers.get(r.order_id, ""), "delta_minor": r.fee_minor - r.billed_minor, "basis_minor": r.basis_minor,
                  "rate_bps": r.rate_bps, "min_minor": r.min_minor, "accrued_at": clock.iso(r.accrued_at)} for r in rows]
        charges = sum(line["delta_minor"] for line in lines if line["delta_minor"] > 0)
        credit = -sum(line["delta_minor"] for line in lines if line["delta_minor"] < 0)
        if charges - credit <= 0:
            return "skipped"  # nothing owed yet (a credit waits for the next charges)
        currency = rows[0].currency
        count = db.scalar(select(func.count()).select_from(FeeInvoice).where(FeeInvoice.merchant_id == merchant.id)) or 0
        # Invoice numbers are unique across the whole PayPal account (shared by every environment), hence the random tail.
        number = f"LCF-{merchant.id[-6:].upper()}-{count + 1:03d}-{secrets.token_hex(2).upper()}"
        invoice = FeeInvoice(id=new_id("finv"), merchant_id=merchant.id, number=number, status="CREATING",
                             currency=currency, charges_minor=charges, credit_minor=credit, amount_minor=charges - credit, orders=len(lines),
                             lines=lines, period_end=until, recipient_email=_recipient(db, merchant), request_id=new_request_id())
        db.add(invoice)
        db.flush()
        for r in rows:
            r.invoice_id = invoice.id  # held for this invoice until PayPal has it
        body = _invoice_body(merchant, invoice)
        invoice_id, request_id = invoice.id, invoice.request_id
    client = get_client()
    try:
        created = client.create_invoice(body, request_id)
        paypal_id = created.get("id")
        with transaction() as db:
            db.get(FeeInvoice, invoice_id, with_for_update=True).paypal_invoice_id = paypal_id
        client.send_invoice(paypal_id, f"{request_id}-send")
    except PayPalOutcomeUnknown as exc:
        _set_status(invoice_id, "SENDING", error={"kind": "outcome_unknown", "detail": str(exc)[:200]})  # the status check resolves it
        return "sent"
    except PayPalError as exc:
        _release(invoice_id, "FAILED", error={"kind": "paypal_error", "name": exc.name, "issue": exc.issue, "detail": str(exc)[:200]})
        log.warning("fee invoice failed", extra={"merchant_id": merchant.id, "issue": exc.issue})
        return "failed"
    sync(invoice_id)
    with transaction() as db:
        audit.record(db, actor=actor, actor_role="system", entity_type="fee_invoice", entity_id=invoice_id, action="fee_invoice_sent",
                     meta={"merchant_id": merchant.id, "amount_minor": charges - credit, "orders": len(lines), "paypal_invoice_id": paypal_id})
    return "sent"


def _invoice_body(merchant: Merchant, invoice: FeeInvoice) -> dict[str, Any]:
    cur = invoice.currency
    tz = ZoneInfo(merchant.timezone)
    charges = [line for line in invoice.lines if line["delta_minor"] > 0]
    if len(charges) > MAX_LINES:  # a very busy week: one line per day instead
        by_day: dict[str, dict[str, Any]] = {}
        for line in charges:
            day = datetime.fromisoformat(line["accrued_at"].replace("Z", "+00:00")).astimezone(tz).strftime("%a %b %-d")
            group = by_day.setdefault(day, {"name": f"Orders on {day}", "count": 0, "minor": 0})
            group["count"] += 1
            group["minor"] += line["delta_minor"]
        items = [{"name": g["name"], "description": f"{g['count']} orders", "quantity": "1",
                  "unit_amount": {"currency_code": cur, "value": to_decimal_string(g["minor"], cur)}} for g in by_day.values()]
    else:
        items = []
        for line in charges:
            when = datetime.fromisoformat(line["accrued_at"].replace("Z", "+00:00")).astimezone(tz).strftime("%b %-d")
            at_rate = (line["basis_minor"] * line["rate_bps"] + 5000) // 10000
            how = "minimum fee" if at_rate < line["min_minor"] else f"{Decimal(line['rate_bps']) / 100:g}% of {format_money(line['basis_minor'], cur)} items"
            items.append({"name": f"Order {line['order_number']}"[:200], "description": f"{when}: {how}"[:1000], "quantity": "1",
                          "unit_amount": {"currency_code": cur, "value": to_decimal_string(line["delta_minor"], cur)}})
    body: dict[str, Any] = {
        "detail": {"invoice_number": invoice.number, "currency_code": cur, "payment_term": {"term_type": "NET_15"}, "reference": merchant.slug[:120],
                   "note": (f"LastCall fees for {merchant.name}. Your customers paid you directly through PayPal; this covers LastCall's commission "
                            f"on those orders.")[:4000]},
        "invoicer": {"business_name": "LastCall"},
        "primary_recipients": [{"billing_info": {"business_name": merchant.name[:300], "email_address": invoice.recipient_email}}],
        "items": items,
    }
    if invoice.credit_minor:
        body["amount"] = {"breakdown": {"discount": {"invoice_discount": {"amount": {"currency_code": cur, "value": to_decimal_string(invoice.credit_minor, cur)}}}}}
    return body


def _recipient(db: Session, merchant: Merchant) -> str:
    owner = db.scalar(select(User.email).join(Membership, Membership.user_id == User.id)
                      .where(Membership.merchant_id == merchant.id, Membership.role == "owner").order_by(Membership.created_at).limit(1))
    return owner or merchant.support_email or ""


# --------------------------------------------------------------------------- invoice status (webhooks and a periodic check)


@jobs.handler("fees.sync", every=900)
def _sync_open(_: dict[str, Any]) -> dict[str, Any]:
    with transaction() as db:
        ids = db.scalars(select(FeeInvoice.id).where(FeeInvoice.status.in_(OPEN), FeeInvoice.paypal_invoice_id.is_not(None))).all()
    return {"checked": len(ids), "results": [sync(i) for i in ids]}


def on_webhook(paypal_invoice_id: str | None) -> str:
    """INVOICING.INVOICE.PAID / CANCELLED / UPDATED: re-read the invoice from PayPal (the event itself is never trusted for state)."""
    with transaction() as db:
        invoice_id = db.scalar(select(FeeInvoice.id).where(FeeInvoice.paypal_invoice_id == paypal_invoice_id)) if paypal_invoice_id else None
    return sync(invoice_id) if invoice_id else "unmatched"


def sync(invoice_id: str) -> str:
    with transaction() as db:
        invoice = db.get(FeeInvoice, invoice_id)
        paypal_id = invoice.paypal_invoice_id if invoice else None
    if not paypal_id:
        return "no_paypal_invoice"
    try:
        found = get_client().get_invoice(paypal_id)
    except (PayPalError, PayPalOutcomeUnknown) as exc:
        log.warning("fee invoice status check failed", extra={"invoice_id": invoice_id, "error": str(exc)[:200]})
        return "unreachable"
    status = found.get("status") or "SENT"
    url = ((found.get("detail") or {}).get("metadata") or {}).get("recipient_view_url")
    if status == "CANCELLED":
        _release(invoice_id, "CANCELLED")
        return status
    with transaction() as db:
        invoice = db.get(FeeInvoice, invoice_id, with_for_update=True)
        was = invoice.status
        invoice.status = status
        invoice.payer_url = url or invoice.payer_url
        if status not in ("DRAFT", "CREATING", "SENDING") and invoice.sent_at is None:
            invoice.sent_at = clock.now()
            for line in invoice.lines:  # billed once PayPal has sent it
                fee = db.get(PlatformFee, line["fee_id"], with_for_update=True)
                fee.billed_minor += line["delta_minor"]
                fee.invoice_id = None
        if status in PAID and invoice.paid_at is None:
            invoice.paid_at = clock.now()
            audit.record(db, actor="provider:paypal", actor_role="system", entity_type="fee_invoice", entity_id=invoice.id, action="fee_invoice_paid",
                         meta={"amount_minor": invoice.amount_minor, "previous": was})
    return status


def _set_status(invoice_id: str, status: str, *, error: dict[str, Any] | None = None) -> None:
    with transaction() as db:
        invoice = db.get(FeeInvoice, invoice_id, with_for_update=True)
        invoice.status = status
        invoice.last_error = error


def _release(invoice_id: str, status: str, *, error: dict[str, Any] | None = None) -> None:
    """The invoice won't be paid: its fees go back to be billed again (undoing what it billed, if it was sent)."""
    with transaction() as db:
        invoice = db.get(FeeInvoice, invoice_id, with_for_update=True)
        for line in invoice.lines:
            fee = db.get(PlatformFee, line["fee_id"], with_for_update=True)
            if invoice.sent_at is not None:
                fee.billed_minor = max(0, fee.billed_minor - line["delta_minor"])
            if fee.invoice_id == invoice.id:
                fee.invoice_id = None
        invoice.status = status
        invoice.last_error = error


# --------------------------------------------------------------------------- views


def _invoice_view(invoice: FeeInvoice, tz: str, shop: str | None = None) -> dict[str, Any]:
    end = invoice.period_end.astimezone(ZoneInfo(tz))
    return {"id": invoice.id, "number": invoice.number, "status": invoice.status, "amount_minor": invoice.amount_minor, "credit_minor": invoice.credit_minor,
            "currency": invoice.currency, "orders": invoice.orders, "period_label": f"Up to {end:%b} {end.day}", "payer_url": invoice.payer_url,
            "sent_at": clock.iso(invoice.sent_at) if invoice.sent_at else None, "paid_at": clock.iso(invoice.paid_at) if invoice.paid_at else None,
            **({"shop": shop} if shop else {})}


def shop_view(db: Session, merchant: Merchant) -> dict[str, Any]:
    """The shop's side: the terms, what's due on the next invoice, and its recent invoices."""
    week_start = period_end(merchant, clock.now())
    week = db.execute(select(func.count(), func.coalesce(func.sum(PlatformFee.fee_minor), 0))
                      .where(PlatformFee.merchant_id == merchant.id, PlatformFee.accrued_at >= week_start)).one()
    due = db.scalar(select(func.coalesce(func.sum(PlatformFee.fee_minor - PlatformFee.billed_minor), 0))
                    .where(PlatformFee.merchant_id == merchant.id, PlatformFee.invoice_id.is_(None))) or 0
    invoices = db.scalars(select(FeeInvoice).where(FeeInvoice.merchant_id == merchant.id, FeeInvoice.status != "FAILED")
                          .order_by(FeeInvoice.created_at.desc()).limit(8)).all()
    return {"terms": terms(), "week": {"orders": week[0], "fee_minor": week[1]}, "next_invoice_minor": max(0, due),
            "recipient": _recipient(db, merchant), "invoices": [_invoice_view(i, merchant.timezone) for i in invoices]}


def platform_view() -> dict[str, Any]:
    """Platform ops: what LastCall earned and billed."""
    now = clock.now()
    with transaction() as db:
        since = now - timedelta(days=7)
        week = db.execute(select(func.count(), func.coalesce(func.sum(PlatformFee.fee_minor), 0)).where(PlatformFee.accrued_at >= since)).one()
        unbilled = db.scalar(select(func.coalesce(func.sum(PlatformFee.fee_minor - PlatformFee.billed_minor), 0)).where(PlatformFee.invoice_id.is_(None))) or 0
        open_minor = db.scalar(select(func.coalesce(func.sum(FeeInvoice.amount_minor), 0)).where(FeeInvoice.status.in_(OPEN))) or 0
        paid_minor = db.scalar(select(func.coalesce(func.sum(FeeInvoice.amount_minor), 0)).where(FeeInvoice.status.in_(PAID))) or 0
        rows = db.execute(select(FeeInvoice, Merchant.name, Merchant.timezone).join(Merchant, Merchant.id == FeeInvoice.merchant_id)
                          .order_by(FeeInvoice.created_at.desc()).limit(20)).all()
        return {"terms": terms(), "week": {"orders": week[0], "fee_minor": week[1]}, "unbilled_minor": max(0, unbilled), "invoiced_open_minor": open_minor,
                "paid_minor": paid_minor, "invoices": [_invoice_view(inv, tz, shop=name) for inv, name, tz in rows]}
