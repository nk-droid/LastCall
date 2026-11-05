"""Single source of "now" so tests can freeze and advance time deterministically."""

from __future__ import annotations

import threading
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

_lock = threading.Lock()
_frozen: datetime | None = None
_offset = timedelta(0)


def now() -> datetime:
    with _lock:
        if _frozen is not None:
            return _frozen
        return datetime.now(UTC) + _offset


def freeze(at: datetime) -> None:
    global _frozen
    if at.tzinfo is None:
        raise ValueError("freeze() requires an aware datetime")
    with _lock:
        _frozen = at.astimezone(UTC)


def advance(delta: timedelta) -> datetime:
    global _frozen, _offset
    with _lock:
        if _frozen is not None:
            _frozen = _frozen + delta
            return _frozen
        _offset = _offset + delta
        return datetime.now(UTC) + _offset


def reset() -> None:
    global _frozen, _offset
    with _lock:
        _frozen = None
        _offset = timedelta(0)


def local_now(tz: str) -> datetime:
    return now().astimezone(ZoneInfo(tz))


def local_date(tz: str) -> date:
    return local_now(tz).date()


def combine_local(day: date, hhmm: str, tz: str) -> datetime:
    """Merchant-local wall time on `day` as an aware UTC datetime."""
    hour, minute = (int(part) for part in hhmm.split(":"))
    return datetime.combine(day, time(hour, minute), tzinfo=ZoneInfo(tz)).astimezone(UTC)


def hhmm(dt: datetime, tz: str) -> str:
    return dt.astimezone(ZoneInfo(tz)).strftime("%H:%M")


def display_time(dt: datetime, tz: str) -> str:
    """'5:45 PM' style label in the merchant's timezone."""
    local = dt.astimezone(ZoneInfo(tz))
    return local.strftime("%-I:%M %p")


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z") if dt else None
