"""Public storefront endpoints: the shop directory and each shop's profile, catalog and pickup slots.

Only live shops are listed. A shop's own members can open its storefront before it goes live
(``preview: true``), so they can check what shoppers will see.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app import clock
from app.ai.provider import describe_provider
from app.api.deps import optional_user, shopper_session
from app.config import settings
from app.db import transaction
from app.errors import Unprocessable
from app.models import Merchant
from app.services import analytics, pickup
from app.services.accounts import SessionUser
from app.services.catalog import address_line, catalog_items, get_merchant, item_view, list_merchants

router = APIRouter(prefix="/api", tags=["public"])

PUBLIC_POLICY_KEYS = ("cancellation_policy_text", "refund_policy_text", "reference_price_policy_text", "dietary_disclosure_text",
                      "cross_contact_text", "pickup_instructions", "what_to_bring", "cancellation_cutoff_minutes", "reservation_ttl_seconds",
                      "max_units_per_order")


def _slug(slug: str) -> str:
    if not slug or len(slug) > 80:
        raise Unprocessable("Invalid shop", code="merchant_invalid")
    return slug


def _viewer(user: SessionUser | None) -> str | None:
    return user.user_id if user else None


def merchant_card(db, merchant: Merchant, now) -> dict[str, Any]:
    """Directory entry: enough to choose a shop at a glance."""
    pickup.ensure_slots(db, merchant, now)
    status = pickup.pickup_status(db, merchant, now)
    sellable = [i for i in catalog_items(db, merchant, now) if i.status == "active" and i.sellable]
    if status["state"] == "open" and not sellable:
        status = {**status, "state": "no_surplus"}
    savings = [round(100 * (1 - i.sale_minor / i.reference_minor)) for i in sellable if i.reference_minor]
    featured = sorted(sellable, key=lambda i: (-i.surplus_priority, -i.available, i.sku))[:4]
    return {
        "slug": merchant.slug,
        "name": merchant.name,
        "tagline": merchant.tagline,
        "category": merchant.category,
        "neighborhood": (merchant.address or {}).get("city", ""),
        "address": address_line(merchant),
        "pickup": status,
        "surplus": {"items_available": len(sellable), "units_available": sum(i.available for i in sellable)},
        "max_saving_percent": max(savings) if savings else 0,
        "from_minor": min((i.sale_minor for i in sellable), default=None),
        "currency": merchant.currency,
        "featured": [{"name": i.name, "image_url": i.image_url} for i in featured],
    }


def merchant_public(db, merchant: Merchant) -> dict[str, Any]:
    now = clock.now()
    pickup.ensure_slots(db, merchant, now)
    status = pickup.pickup_status(db, merchant, now)
    sellable = [i for i in catalog_items(db, merchant, now) if i.status == "active" and i.sellable]
    address = merchant.address or {}
    policies = merchant.policies or {}
    if status["state"] == "open" and not sellable:
        status = {**status, "state": "no_surplus"}
    today_hours = (merchant.hours or {}).get(pickup.WEEKDAYS[clock.local_date(merchant.timezone).weekday()])
    return {
        "slug": merchant.slug,
        "name": merchant.name,
        "category": merchant.category,
        "tagline": merchant.tagline,
        "description": merchant.description,
        "address": {**address, "one_line": address_line(merchant)},
        "phone": merchant.phone,
        "support_email": merchant.support_email,
        "timezone": merchant.timezone,
        "currency": merchant.currency,
        "hours_today": {"open": pickup._fmt(today_hours[0]), "close": pickup._fmt(today_hours[1])} if today_hours else None,
        "pickup": {**status, "slot_minutes": (merchant.pickup_config or {}).get("slot_minutes")},
        "verification": {k: v for k, v in (merchant.verification or {}).items() if k in ("verified_by", "verified_at", "checks")},
        "policies": {k: policies.get(k) for k in PUBLIC_POLICY_KEYS},
        "policy_version": merchant.policy_version,
        "surplus": {"items_available": len(sellable), "units_available": sum(i.available for i in sellable), "as_of": clock.iso(now)},
        "preview": not merchant.is_live,
    }


@router.get("/merchants")
def merchants() -> dict[str, Any]:
    with transaction() as db:
        now = clock.now()
        return {"merchants": [merchant_card(db, m, now) for m in list_merchants(db)], "as_of": clock.iso(now)}


@router.get("/merchants/{slug}")
def merchant_by_slug(slug: str, user: SessionUser | None = Depends(optional_user)) -> dict[str, Any]:
    with transaction() as db:
        return merchant_public(db, get_merchant(db, _slug(slug), viewer_id=_viewer(user)))


@router.get("/merchants/{slug}/catalog")
def merchant_catalog(slug: str, user: SessionUser | None = Depends(optional_user)) -> dict[str, Any]:
    with transaction() as db:
        m = get_merchant(db, _slug(slug), viewer_id=_viewer(user))
        now = clock.now()
        items = [item_view(i, m, now) for i in catalog_items(db, m, now) if i.status == "active"]
        return {"merchant": {"slug": m.slug, "name": m.name}, "items": items, "as_of": clock.iso(now), "currency": m.currency,
                "reference_price_policy": (m.policies or {}).get("reference_price_policy_text")}


@router.get("/merchants/{slug}/pickup-slots")
def merchant_pickup_slots(slug: str, user: SessionUser | None = Depends(optional_user)) -> dict[str, Any]:
    with transaction() as db:
        m = get_merchant(db, _slug(slug), viewer_id=_viewer(user))
        now = clock.now()
        pickup.ensure_slots(db, m, now)
        return {"slots": [pickup.slot_view(s, m, now) for s in pickup.list_slots(db, m, now)], "as_of": clock.iso(now)}


@router.get("/config")
def config(_: str = Depends(shopper_session)) -> dict[str, Any]:
    """Public client configuration (also establishes the shopper session cookie)."""
    s = settings()
    # The public client ID loads PayPal's buttons; null means checkout isn't available.
    return {"ai": {"enabled": describe_provider()["enabled"]},
            "paypal": {"client_id": s.paypal_client_id if s.paypal_configured else None, "currency": "USD"}}


class ClientEvent(BaseModel):
    name: str = Field(max_length=40)
    merchant: str = Field(min_length=1, max_length=80)
    entity_type: str | None = Field(default=None, max_length=40)
    entity_id: str | None = Field(default=None, max_length=64)


@router.post("/events", status_code=202)
def client_event(event: ClientEvent, session_id: str = Depends(shopper_session)) -> dict[str, str]:
    if event.name not in analytics.CLIENT_EVENTS:
        raise Unprocessable("Unknown event", code="unknown_event")
    with transaction() as db:
        m = get_merchant(db, _slug(event.merchant))
        analytics.track(db, event.name, merchant_id=m.id, session_id=session_id, entity_type=event.entity_type, entity_id=event.entity_id)
    return {"status": "recorded"}
