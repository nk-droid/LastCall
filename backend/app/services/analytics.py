"""Product analytics events (taxonomy from the spec). Properties never carry contact details."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app import clock
from app.models import AnalyticsEvent

TAXONOMY = {
    "intent_submitted",
    "bundle_proposed",
    "bundle_viewed",
    "bundle_accepted",
    "substitution_offered",
    "substitution_accepted",
    "substitution_rejected",
    "quote_created",
    "reservation_created",
    "reservation_rejected_stock",
    "reservation_expired",
    "checkout_started",
    "paypal_approved",
    "capture_verified",
    "pickup_ready",
    "pickup_completed",
    "refund_verified",
    "stockout",
}

# Events the browser may report; everything else is emitted server-side only.
CLIENT_EVENTS = {"bundle_viewed"}


def track(
    db: Session,
    name: str,
    *,
    merchant_id: str,
    session_id: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    properties: dict[str, Any] | None = None,
) -> None:
    if name not in TAXONOMY:
        raise ValueError(f"unknown analytics event {name}")
    db.add(
        AnalyticsEvent(
            merchant_id=merchant_id,
            event_name=name,
            session_id=session_id,
            entity_type=entity_type,
            entity_id=entity_id,
            properties=properties or {},
            created_at=clock.now(),
        )
    )
