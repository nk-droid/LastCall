"""ReservationService: atomic inventory holds.

Concurrency model: every writer that can reduce availability for a product first locks that
product's inventory lot row (``SELECT ... FOR UPDATE``, always in product-id order to avoid
deadlocks) and recomputes availability from reservation rows under the lock. Two buyers
racing for the last unit therefore serialize, and the second sees zero available.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import clock
from app.domain import Intent
from app.ids import new_id
from app.models import BundleQuote, InventoryEvent, InventoryLot, Merchant, PickupSlot, Reservation, ReservationLine
from app.services import analytics, audit, pickup
from app.services.catalog import catalog_items, policy
from app.services.feasibility import Problem, validate_lines


def lock_lots(db: Session, product_ids: list[str]) -> dict[str, InventoryLot]:
    lots = db.scalars(
        select(InventoryLot).where(InventoryLot.product_id.in_(sorted(set(product_ids)))).order_by(InventoryLot.product_id).with_for_update()
    ).all()
    return {lot.product_id: lot for lot in lots}


def quote_intent(quote: BundleQuote) -> Intent | None:
    raw = (quote.eligibility_snapshot or {}).get("intent")
    return Intent.model_validate(raw) if raw else None


def acquire(
    db: Session,
    *,
    merchant: Merchant,
    quote: BundleQuote,
    now: datetime,
    existing: Reservation | None,
    check_prices: bool = True,
    enforce_slot_rules: bool = True,
) -> tuple[Reservation | None, list[Problem]]:
    """Hold every line of ``quote`` or nothing. Caller owns the transaction."""
    product_ids = [line["product_id"] for line in quote.item_lines]
    lock_lots(db, product_ids)
    items = catalog_items(db, merchant, now, exclude_reservation_id=existing.id if existing else None)
    by_sku = {i.sku: i for i in items}
    slot = db.get(PickupSlot, quote.pickup_slot_id)
    tz_label = lambda dt: clock.display_time(dt, merchant.timezone)  # noqa: E731
    problems = validate_lines(
        [(line["sku"], line["qty"]) for line in quote.item_lines],
        by_sku,
        quote_intent(quote),
        max_units=int(policy(merchant, "max_units_per_order", 12)),
        slot_ends_at=slot.ends_at if slot else None,
        require_portions=False,
        tz_label=tz_label,
    )
    if check_prices:
        for line in quote.item_lines:
            item = by_sku.get(line["sku"])
            if item and item.sale_minor != line["unit_sale_minor"]:
                problems.append(Problem("price_changed", f"{item.name} price changed", line["sku"]))
    if problems:
        return None, problems

    needs_slot = existing is None or not existing.slot_booked
    if needs_slot:
        if enforce_slot_rules:
            ok, reason = pickup.slot_bookable(pickup.lock_slot(db, quote.pickup_slot_id), merchant, now)
            if not ok:
                return None, [Problem("slot_unavailable", reason or "Pickup slot unavailable")]
        slot_row = pickup.lock_slot(db, quote.pickup_slot_id)
        slot_row.booked_count += 1

    ttl = int(policy(merchant, "reservation_ttl_seconds", 600))
    sku_qty = {line["sku"]: line["qty"] for line in quote.item_lines}
    if existing is None:
        res = Reservation(
            id=new_id("rsv"),
            quote_id=quote.id,
            merchant_id=merchant.id,
            session_id=quote.session_id,
            pickup_slot_id=quote.pickup_slot_id,
            sku_qty=sku_qty,
            state="HELD",
            slot_booked=True,
            expires_at=now + timedelta(seconds=ttl),
        )
        db.add(res)
        db.flush()
    else:
        res = existing
        db.execute(delete(ReservationLine).where(ReservationLine.reservation_id == res.id))
        res.state = "HELD"
        res.sku_qty = sku_qty
        res.slot_booked = True
        res.expires_at = now + timedelta(seconds=ttl)
        res.released_reason = None
        res.released_at = None
    for line in quote.item_lines:
        db.add(ReservationLine(id=new_id("rl"), reservation_id=res.id, product_id=line["product_id"], sku=line["sku"], qty=line["qty"]))
    for line in quote.item_lines:
        item = by_sku[line["sku"]]
        if item.available - line["qty"] <= 0:
            analytics.track(db, "stockout", merchant_id=merchant.id, entity_type="product", entity_id=item.product_id, properties={"sku": item.sku, "via": "reservation"})
    db.flush()
    return res, []


def release(db: Session, res: Reservation, reason: str, now: datetime, *, actor: str = "system:worker", role: str = "system") -> bool:
    """Release a hold or a paid-but-unfulfilled allocation back to sellable stock.

    Callers must reconcile PAYMENT_IN_FLIGHT holds first, and only release COMMITTED units when
    the order is cancelled.
    """
    if res.state not in ("HELD", "PAYMENT_IN_FLIGHT", "COMMITTED"):
        return False
    previous = res.state
    res.state = "RELEASED"
    res.released_reason = reason
    res.released_at = now
    if res.slot_booked:
        pickup.unbook(db, res.pickup_slot_id)
        res.slot_booked = False
    audit.record(db, actor=actor, actor_role=role, entity_type="reservation", entity_id=res.id, action="released",
                 meta={"reason": reason, "previous_state": previous})
    if reason in ("expired", "abandoned"):
        analytics.track(db, "reservation_expired", merchant_id=res.merchant_id, session_id=res.session_id,
                        entity_type="reservation", entity_id=res.id, properties={"reason": reason})
    return True


def commit(db: Session, res: Reservation, merchant: Merchant, now: datetime) -> list[str]:
    """Convert a hold into an allocation after a verified capture."""
    if res.state in ("COMMITTED", "FULFILLED"):
        return []
    if res.state == "RELEASED":
        quote = db.get(BundleQuote, res.quote_id)
        reacquired, problems = acquire(db, merchant=merchant, quote=quote, now=now, existing=res, check_prices=False, enforce_slot_rules=False)
        if reacquired is None:
            return [p.message for p in problems] or ["stock_shortage"]
    res.state = "COMMITTED"
    res.committed_at = now
    return []


def _adjust_lots(db: Session, res: Reservation, merchant: Merchant, now: datetime, event_type: str, actor: str, reason: str, reference_id: str) -> None:
    lines = db.scalars(select(ReservationLine).where(ReservationLine.reservation_id == res.id)).all()
    lots = lock_lots(db, [line.product_id for line in lines])
    for line in lines:
        lot = lots[line.product_id]
        before = lot.surplus_qty
        lot.surplus_qty = max(0, lot.surplus_qty - line.qty)
        lot.on_hand = max(0, lot.on_hand - line.qty)
        lot.version += 1
        lot.updated_at = now
        lot.updated_by = actor
        db.add(InventoryEvent(merchant_id=merchant.id, product_id=line.product_id, sku=line.sku, event_type=event_type,
                              delta=lot.surplus_qty - before, surplus_before=before, surplus_after=lot.surplus_qty,
                              actor=actor, reason=reason, reference_id=reference_id, created_at=now))


def fulfill(db: Session, res: Reservation, merchant: Merchant, now: datetime, actor: str, order_id: str) -> None:
    """Handoff: the units physically leave, so surplus and the allocation drop together."""
    if res.state == "FULFILLED":
        return
    _adjust_lots(db, res, merchant, now, "FULFILLED", actor, "Order handed off", order_id)
    res.state = "FULFILLED"
    res.fulfilled_at = now


def write_off(db: Session, res: Reservation, merchant: Merchant, now: datetime, actor: str, order_id: str, reason: str) -> None:
    """Cancelled after packing: units are not returned to sellable stock."""
    if res.state not in ("COMMITTED", "HELD", "PAYMENT_IN_FLIGHT"):
        return
    _adjust_lots(db, res, merchant, now, "WRITE_OFF", actor, reason, order_id)
    release(db, res, "cancelled_write_off", now, actor=actor, role="staff")


def view(res: Reservation | None, now: datetime) -> dict[str, Any] | None:
    if res is None:
        return None
    seconds_left = max(0, int((res.expires_at - now).total_seconds())) if res.state == "HELD" else None
    return {
        "id": res.id,
        "state": res.state,
        "expires_at": clock.iso(res.expires_at),
        "seconds_left": seconds_left,
        "expired": res.state == "HELD" and res.expires_at <= now,
        "quote_id": res.quote_id,
        "pickup_slot_id": res.pickup_slot_id,
    }
