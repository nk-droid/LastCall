"""ReservationService entry points: hold a quote's stock for a shopper, and sweep lapsed holds.

A hold is atomic (row-locked lots, fixed lock order) and has a visible expiry. If the basket
changed since it was quoted, nothing is held: the quote is invalidated and the shopper gets
a substitution offer to accept or reject. Holds with a payment in flight are never released
here; checkout reconciles them first.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select

from app import clock
from app.db import transaction
from app.errors import Conflict, QuoteInvalid
from app.models import BundleQuote, Reservation
from app.services import analytics, audit, jobs, substitution
from app.services import quotes as qs
from app.services import reservations as rsv
from app.services.catalog import merchant_by_id, policy


def reserve_for_session(session_id: str, quote_id: str) -> dict[str, Any]:
    failure: list[dict[str, Any]] | None = None
    slot_only = False
    with transaction() as db:
        quote = qs.load_for_session(db, quote_id, session_id, lock=True)
        merchant = merchant_by_id(db, quote.merchant_id)
        now = clock.now()
        if not merchant.is_live:
            raise Conflict(f"{merchant.name} isn't taking orders right now", code="shop_unavailable")
        if quote.status == "PROPOSED":
            raise Conflict("Review and accept the updated basket first", code="offer_pending")
        if quote.status == "SUPERSEDED":
            latest = qs.latest_in_lineage(db, quote.lineage_id)
            raise Conflict("This basket was replaced by a newer version", code="quote_superseded",
                           details={"latest_quote_id": latest.id if latest else None})
        existing = db.scalar(select(Reservation).where(Reservation.quote_id == quote.id).with_for_update())
        if existing is not None and (existing.state in ("PAYMENT_IN_FLIGHT", "COMMITTED", "FULFILLED")
                                     or (existing.state == "HELD" and existing.expires_at > now)):
            return {"reservation": rsv.view(existing, now), "quote": qs.view(db, quote, merchant, now, problems=[])}
        if quote.status == "CONVERTED":
            raise Conflict("This basket has already been ordered", code="quote_converted")
        if quote.expires_at <= now and quote.status == "ACTIVE":
            raise Conflict("This quote expired; refresh it to re-check prices and stock", code="quote_expired")
        if quote.status != "ACTIVE":
            failure = quote.invalid_reason or [{"kind": "invalid", "message": "This basket is no longer valid"}]
        else:
            res, problems = rsv.acquire(db, merchant=merchant, quote=quote, now=now, existing=existing)
            if res is not None:
                analytics.track(db, "reservation_created", merchant_id=merchant.id, session_id=session_id, entity_type="reservation",
                                entity_id=res.id, properties={"quote_id": quote.id, "ttl_seconds": int(policy(merchant, "reservation_ttl_seconds", 600))})
                audit.record(db, actor=audit.customer_actor(session_id), actor_role="customer", entity_type="reservation", entity_id=res.id,
                             action="reservation_created", meta={"quote_id": quote.id, "expires_at": clock.iso(res.expires_at)}, trace_id=quote.trace_id)
                return {"reservation": rsv.view(res, now), "quote": qs.view(db, quote, merchant, now, problems=[])}
            failure = [p.to_dict() for p in problems]
            slot_only = all(p.kind == "slot_unavailable" for p in problems)
            if any(p.kind in ("sold_out", "insufficient_stock") for p in problems):
                analytics.track(db, "reservation_rejected_stock", merchant_id=merchant.id, session_id=session_id,
                                entity_type="quote", entity_id=quote.id, properties={"problems": failure})
            if not slot_only:
                quote.status = "INVALIDATED"
                quote.invalid_reason = failure
    if slot_only:
        raise Conflict("That pickup slot just filled up; choose another time", code="slot_unavailable", details={"problems": failure})
    offer = substitution.offer_for_problems(session_id, quote_id)
    raise QuoteInvalid("Your basket changed before we could hold it", details={"problems": failure, "offer": offer})


def sweep_expired() -> dict[str, int]:
    """Release HELD holds past their expiry and expire long-abandoned quotes."""
    now = clock.now()
    released = 0
    with transaction() as db:
        expired = db.scalars(
            select(Reservation).where(Reservation.state == "HELD", Reservation.expires_at <= now).with_for_update(skip_locked=True).limit(200)
        ).all()
        for res in expired:
            if rsv.release(db, res, "expired", now):
                released += 1
        stale_quotes = db.scalars(
            select(BundleQuote).where(BundleQuote.status.in_(["ACTIVE", "PROPOSED"]), BundleQuote.expires_at <= now - timedelta(hours=1)).limit(200)
        ).all()
        for quote in stale_quotes:
            if qs.active_reservation(db, quote.id, now) is None:
                quote.status = "EXPIRED"
    return {"released": released}


@jobs.handler("holds.sweep", every=15)
def _sweep(_: dict[str, Any]) -> dict[str, Any]:
    return sweep_expired()
