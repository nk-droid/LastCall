"""PickupCapacityService: slots come only from merchant-configured pickup windows and capacity.

Each weekday has its own pickup window (or none). Slots for today and tomorrow are generated
idempotently, both on demand and by a periodic job, so a storefront never shows invented times.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.errors import Conflict, NotFound
from app.ids import new_id
from app.models import BundleQuote, Merchant, PickupSlot, Reservation
from app.services import jobs
from app.services.catalog import policy

WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def window_for(merchant: Merchant, day: date) -> tuple[str, str] | None:
    window = ((merchant.pickup_config or {}).get("windows") or {}).get(WEEKDAYS[day.weekday()])
    return (window[0], window[1]) if window else None


def reference_window(merchant: Merchant) -> tuple[str, str]:
    """The pickup window shoppers most likely mean: today's, else the next open day's."""
    today = clock.local_date(merchant.timezone)
    for offset in range(7):
        window = window_for(merchant, today + timedelta(days=offset))
        if window:
            return window
    return ("16:00", "19:00")


def _is_open_on(merchant: Merchant, day: date) -> bool:
    return window_for(merchant, day) is not None


def ensure_slots(db: Session, merchant: Merchant, now: datetime | None = None, days: int = 2) -> None:
    """Idempotently create today's and tomorrow's slots from the merchant's pickup windows."""
    now = now or clock.now()
    cfg = merchant.pickup_config or {}
    minutes = int(cfg.get("slot_minutes", 30))
    capacity = int(cfg.get("capacity", 6))
    today = clock.local_date(merchant.timezone)
    rows: list[dict[str, Any]] = []
    for offset in range(days):
        day = today + timedelta(days=offset)
        window = window_for(merchant, day)
        if window is None:
            continue
        start, end = window
        slot_start = clock.combine_local(day, start, merchant.timezone)
        window_end = clock.combine_local(day, end, merchant.timezone)
        while slot_start + timedelta(minutes=minutes) <= window_end:
            rows.append(
                {
                    "id": new_id("slot"),
                    "merchant_id": merchant.id,
                    "starts_at": slot_start,
                    "ends_at": slot_start + timedelta(minutes=minutes),
                    "capacity": capacity,
                    "booked_count": 0,
                    "status": "open",
                }
            )
            slot_start += timedelta(minutes=minutes)
    if rows:
        db.execute(insert(PickupSlot).values(rows).on_conflict_do_nothing(index_elements=["merchant_id", "starts_at"]))


def slot_bookable(slot: PickupSlot, merchant: Merchant, now: datetime, ignore_capacity: bool = False) -> tuple[bool, str | None]:
    lead = timedelta(minutes=int(policy(merchant, "min_lead_minutes", 10)))
    if merchant.pickup_paused:
        return False, "Pickup is paused by the merchant"
    if slot.status != "open":
        return False, "This pickup slot was closed by the merchant"
    if slot.starts_at <= now + lead:
        return False, "This pickup slot has already started or is about to start"
    if slot.booked_count >= slot.capacity and not ignore_capacity:
        return False, "This pickup slot is fully booked"
    return True, None


def slot_label(slot: PickupSlot | dict[str, Any], tz: str) -> str:
    starts = slot["starts_at"] if isinstance(slot, dict) else slot.starts_at
    ends = slot["ends_at"] if isinstance(slot, dict) else slot.ends_at
    if isinstance(starts, str):
        starts = datetime.fromisoformat(starts.replace("Z", "+00:00"))
        ends = datetime.fromisoformat(ends.replace("Z", "+00:00"))
    local_day = clock.local_date(tz)
    day = starts.astimezone(ZoneInfo(tz)).date()
    prefix = "Today" if day == local_day else ("Tomorrow" if day == local_day + timedelta(days=1) else day.strftime("%a %b %-d"))
    return f"{prefix} {clock.display_time(starts, tz)}–{clock.display_time(ends, tz)}"


def slot_view(slot: PickupSlot, merchant: Merchant, now: datetime) -> dict[str, Any]:
    bookable, reason = slot_bookable(slot, merchant, now)
    return {
        "id": slot.id,
        "starts_at": clock.iso(slot.starts_at),
        "ends_at": clock.iso(slot.ends_at),
        "start_local": clock.hhmm(slot.starts_at, merchant.timezone),
        "end_local": clock.hhmm(slot.ends_at, merchant.timezone),
        "date_local": slot.starts_at.astimezone(ZoneInfo(merchant.timezone)).date().isoformat(),
        "label": slot_label(slot, merchant.timezone),
        "capacity": slot.capacity,
        "booked": slot.booked_count,
        "remaining": max(0, slot.capacity - slot.booked_count),
        "bookable": bookable,
        "unavailable_reason": reason,
    }


def snapshot(slot: PickupSlot, merchant: Merchant) -> dict[str, Any]:
    return {
        "id": slot.id,
        "starts_at": clock.iso(slot.starts_at),
        "ends_at": clock.iso(slot.ends_at),
        "label": slot_label(slot, merchant.timezone),
    }


def list_slots(db: Session, merchant: Merchant, now: datetime | None = None) -> list[PickupSlot]:
    now = now or clock.now()
    return list(
        db.scalars(
            select(PickupSlot)
            .where(PickupSlot.merchant_id == merchant.id, PickupSlot.ends_at > now)
            .order_by(PickupSlot.starts_at)
        ).all()
    )


def slots_for_window(
    slots: list[PickupSlot], merchant: Merchant, pickup_date: str | None, window: tuple[str, str] | None
) -> list[PickupSlot]:
    """Slots on the requested local date whose span lies inside the requested window."""
    tz = ZoneInfo(merchant.timezone)
    target_date = pickup_date or clock.local_date(merchant.timezone).isoformat()
    chosen = []
    for slot in slots:
        local_start = slot.starts_at.astimezone(tz)
        local_end = slot.ends_at.astimezone(tz)
        if local_start.date().isoformat() != target_date:
            continue
        if window:
            start, end = window
            if local_start.strftime("%H:%M") < start or local_end.strftime("%H:%M") > end:
                continue
        chosen.append(slot)
    return chosen


def pickup_status(db: Session, merchant: Merchant, now: datetime | None = None) -> dict[str, Any]:
    """What the storefront may truthfully say about pickup right now."""
    now = now or clock.now()
    slots = list_slots(db, merchant, now)
    bookable = [s for s in slots if slot_bookable(s, merchant, now)[0]]
    today = clock.local_date(merchant.timezone).isoformat()
    window = window_for(merchant, clock.local_date(merchant.timezone))
    today_window = None
    if window:
        today_window = {"start": window[0], "end": window[1], "label": f"{_fmt(window[0])}–{_fmt(window[1])}"}
    today_bookable = [s for s in bookable if slot_view(s, merchant, now)["date_local"] == today]
    if merchant.pickup_paused:
        state = "paused"
    elif today_bookable:
        state = "open"
    elif bookable:
        state = "closed_for_today"
    else:
        state = "unavailable"
    next_slot = bookable[0] if bookable else None
    return {
        "state": state,
        "today_window": today_window,
        "closes_at_label": _fmt(window[1]) if window else None,
        "next_slot": slot_view(next_slot, merchant, now) if next_slot else None,
        "bookable_count": len(bookable),
    }


def _fmt(hhmm: str | None) -> str | None:
    if not hhmm:
        return None
    hour, minute = (int(x) for x in hhmm.split(":"))
    suffix = "AM" if hour < 12 else "PM"
    return f"{(hour % 12) or 12}:{minute:02d} {suffix}"


def lock_slot(db: Session, slot_id: str) -> PickupSlot:
    slot = db.scalar(select(PickupSlot).where(PickupSlot.id == slot_id).with_for_update())
    if slot is None:
        raise NotFound("Pickup slot not found", code="slot_missing")
    return slot


def book(db: Session, slot_id: str, merchant: Merchant, now: datetime) -> PickupSlot:
    slot = lock_slot(db, slot_id)
    ok, reason = slot_bookable(slot, merchant, now)
    if not ok:
        raise Conflict(reason or "Pickup slot unavailable", code="slot_unavailable", details={"slot_id": slot_id})
    slot.booked_count += 1
    return slot


def unbook(db: Session, slot_id: str) -> None:
    slot = lock_slot(db, slot_id)
    slot.booked_count = max(0, slot.booked_count - 1)


def rebuild_open_slots(db: Session, merchant: Merchant) -> None:
    """Apply new pickup windows: drop future slots nobody has booked, keep booked ones, regenerate."""
    now = clock.now()
    capacity = int(merchant.pickup_config.get("capacity", 6))
    for slot in db.scalars(select(PickupSlot).where(PickupSlot.merchant_id == merchant.id, PickupSlot.starts_at > now).with_for_update()).all():
        if slot_in_use(db, slot):
            slot.capacity = max(capacity, slot.booked_count)
        else:
            db.delete(slot)
    db.flush()
    ensure_slots(db, merchant, now)


def slot_in_use(db: Session, slot: PickupSlot) -> bool:
    """Whether a booking, hold or quote references the slot (those keep it; only unused slots are rebuilt)."""
    if slot.booked_count > 0:
        return True
    holds = db.scalar(select(func.count()).select_from(Reservation).where(Reservation.pickup_slot_id == slot.id)) or 0
    quotes = db.scalar(select(func.count()).select_from(BundleQuote).where(BundleQuote.pickup_slot_id == slot.id)) or 0
    return holds > 0 or quotes > 0


def update_slot(db: Session, merchant: Merchant, slot_id: str, capacity: int | None, status: str | None) -> PickupSlot:
    slot = lock_slot(db, slot_id)
    if slot.merchant_id != merchant.id:
        raise NotFound("Pickup slot not found", code="slot_missing")
    if capacity is not None:
        slot.capacity = capacity
    if status is not None:
        slot.status = status
    return slot


@jobs.handler("pickup.ensure_slots", every=600)
def _ensure_all(_: dict[str, Any]) -> dict[str, Any]:
    with transaction() as db:
        merchants = db.scalars(select(Merchant).where(Merchant.status == "live")).all()
        for merchant in merchants:
            ensure_slots(db, merchant)
        return {"merchants": len(merchants)}
