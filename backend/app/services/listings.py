"""Daily listing templates: a shop's standing surplus, re-listed every day at its listing time.

Bakeries and cafés know roughly what they'll have left. A product marked "repeat daily" is
re-listed each day (once, at the shop's ``relist_at_local`` time) with its template quantity and
pickup cutoff. Units still held or owed to paid orders stay on top of the new quantity, so a
re-list never makes stock that's already promised available twice.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.models import InventoryEvent, Merchant, Product, SystemState
from app.services import audit, jobs, pickup
from app.services.access import StaffContext, require_role
from app.services.catalog import availability, lock_lots, merchant_by_id, policy


def _state_key(merchant_id: str) -> str:
    return f"relist:{merchant_id}"


def due(db: Session, merchant: Merchant, now: datetime) -> bool:
    local = clock.local_now(merchant.timezone)
    if local.strftime("%H:%M") < str(policy(merchant, "relist_at_local", "06:00")):
        return False
    state = db.get(SystemState, _state_key(merchant.id))
    return not state or state.value.get("date") != local.date().isoformat()


def _cutoff(merchant: Merchant, product: Product) -> datetime:
    today = clock.local_date(merchant.timezone)
    hhmm = product.relist_cutoff_local or (pickup.window_for(merchant, today) or ("00:00", "23:59"))[1]
    return clock.combine_local(today, hhmm, merchant.timezone)


def relist(db: Session, merchant: Merchant, now: datetime, actor: str = "system:listings") -> int:
    products = db.scalars(select(Product).where(Product.merchant_id == merchant.id, Product.relist_daily.is_(True),
                                                Product.status == "active")).all()
    lots = lock_lots(db, [p.id for p in products])
    avail = availability(db, merchant.id, now, [p.id for p in products])
    count = 0
    for product in products:
        lot, a = lots.get(product.id), avail.get(product.id)
        if lot is None or a is None:
            continue
        before = lot.surplus_qty
        lot.surplus_qty = product.relist_qty + a.reserved + a.committed
        lot.on_hand = max(lot.on_hand, lot.surplus_qty)
        lot.cutoff_at = _cutoff(merchant, product)
        lot.version += 1
        lot.updated_at = now
        lot.updated_by = actor
        db.add(InventoryEvent(merchant_id=merchant.id, product_id=product.id, sku=product.sku, event_type="RELISTED",
                              delta=lot.surplus_qty - before, surplus_before=before, surplus_after=lot.surplus_qty, actor=actor,
                              reason="Daily listing", created_at=now))
        count += 1
    local_date = clock.local_date(merchant.timezone).isoformat()
    state = db.get(SystemState, _state_key(merchant.id), with_for_update=True)
    if state is None:
        db.add(SystemState(key=_state_key(merchant.id), value={"date": local_date, "products": count}))
    else:
        state.value = {"date": local_date, "products": count}
    pickup.ensure_slots(db, merchant, now)
    if count:  # today's listing may fit a shopper's watch
        jobs.enqueue("watches.scan", {"merchant_id": merchant.id}, delay_seconds=15, dedupe_key=f"watches.scan:{merchant.id}", db=db)
    return count


def relist_now(ctx: StaffContext) -> dict[str, Any]:
    """'Publish today's listing' from the console, without waiting for the scheduled time."""
    require_role(ctx, "manager")
    with transaction() as db:
        merchant = merchant_by_id(db, ctx.merchant_id)
        count = relist(db, merchant, clock.now(), actor=ctx.actor)
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="merchant", entity_id=merchant.id, action="daily_listing_published",
                     meta={"products": count})
        return {"relisted": count}


@jobs.handler("listings.relist", every=300)
def _relist_due(_: dict[str, Any]) -> dict[str, Any]:
    now = clock.now()
    done: dict[str, int] = {}
    with transaction() as db:
        for merchant in db.scalars(select(Merchant).where(Merchant.status == "live")).all():
            if due(db, merchant, now):
                done[merchant.slug] = relist(db, merchant, now)
    return {"relisted": done}
