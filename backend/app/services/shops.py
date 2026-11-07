"""Shops: onboarding, profile, hours, pickup windows, policies and the review lifecycle.

A signed-in person creates a shop (they become its owner) in ``draft``. The setup checklist
must be complete before the owner can submit it; a platform admin then approves it
(``live``: listed and able to take orders) or sends it back with a note. Live shops can be
suspended. Policy text changes bump ``policy_version`` so shoppers re-accept at checkout.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from typing import Any
from zoneinfo import available_timezones

from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.errors import Conflict, NotFound, Unprocessable
from app.ids import new_id
from app.models import Membership, Merchant, Product, User, UserSession
from app.payments.payee import display as payee_display
from app.services import audit, mail, pickup
from app.services.access import StaffContext, has_role, require_role
from app.services.accounts import SessionUser, account_view

WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
CATEGORY_SUGGESTIONS = ["Bakery", "Café", "Asian bakery", "Deli", "Dessert shop", "Grocery", "Restaurant", "Juice bar"]
APPROVAL_CHECKS = ["Business identity confirmed", "Pickup address confirmed", "Allergen records reviewed with the owner"]
_HHMM = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

DEFAULT_POLICIES: dict[str, Any] = {
    "reservation_ttl_seconds": 600,
    "quote_ttl_seconds": 900,
    "payment_window_seconds": 900,
    "cancellation_cutoff_minutes": 60,
    "max_units_per_order": 12,
    "min_lead_minutes": 10,
    "low_stock_threshold": 2,
    "stale_inventory_minutes": 240,
    "data_retention_days": 30,
    "no_show_policy": "hold_for_review",
    "no_show_grace_minutes": 30,
    "relist_at_local": "06:00",
    # Close-out assistant: an agent proposes end-of-day changes this many minutes before the last pickup window ends.
    "closeout_enabled": True,
    "closeout_lead_minutes": 60,
    # Ask LastCall (the shopping concierge across all shops) may suggest this shop's bundles.
    "concierge_listed": True,
    "tax_rates_bps": {"bakery": 0},
    "fees_minor": 0,
    "cancellation_policy_text": "You can request a cancellation up to 60 minutes before your pickup window starts. The shop reviews each request; approved cancellations are refunded in full to your PayPal payment method.",
    "refund_policy_text": "Refunds go back to the original PayPal payment. A refund shows as complete only after PayPal confirms it. Items that were collected aren't refundable unless there's a quality problem.",
    "reference_price_policy_text": "Reference prices are this shop's regular menu prices for the same item. Savings are the difference between that price and today's surplus price.",
    "dietary_disclosure_text": "Allergen and ingredient information is supplied and verified by the shop. LastCall does not independently certify allergen safety or freshness. If you have a strict allergy, only items the shop has verified are offered, and items listing cross-contact are excluded.",
    "cross_contact_text": "Our kitchen handles common allergens on shared equipment. Cross-contact can never be fully ruled out.",
    "pickup_instructions": "Come to the counter marked 'LastCall pickup' and show your pickup code. Orders are held until the end of your window.",
    "what_to_bring": "Your pickup code (on your order page). A tote bag is welcome.",
    "scoring_weights": {"preference_fit": 0.35, "variety": 0.20, "value": 0.15, "surplus_priority": 0.20, "portion_fit": 0.10},
}
POLICY_TEXT_KEYS = ("cancellation_policy_text", "refund_policy_text", "reference_price_policy_text", "dietary_disclosure_text",
                    "cross_contact_text", "pickup_instructions", "what_to_bring")
POLICY_NUMBER_LIMITS = {
    "cancellation_cutoff_minutes": (0, 1440), "reservation_ttl_seconds": (120, 3600), "quote_ttl_seconds": (120, 3600),
    "payment_window_seconds": (300, 3600), "max_units_per_order": (1, 100), "min_lead_minutes": (0, 240),
    "low_stock_threshold": (0, 50), "stale_inventory_minutes": (30, 1440), "data_retention_days": (1, 365), "no_show_grace_minutes": (0, 240),
    "closeout_lead_minutes": (15, 240),
}
NO_SHOW_POLICIES = ("hold_for_review", "auto_refund", "auto_cancel_no_refund")


def default_hours() -> dict[str, list[str] | None]:
    return {day: ["07:00", "19:00"] for day in WEEKDAYS}


def default_pickup() -> dict[str, Any]:
    return {"windows": {day: ["16:00", "19:00"] for day in WEEKDAYS}, "slot_minutes": 30, "capacity": 6}


def shop_noun(category: str) -> str:
    """How policy text refers to the shop: 'the bakery', 'the café', otherwise 'the shop'."""
    lowered = category.lower()
    for noun in ("bakery", "café", "cafe", "deli", "restaurant", "grocery"):
        if noun in lowered:
            return "café" if noun == "cafe" else noun
    return "shop"


def personalized_policies(category: str) -> dict[str, Any]:
    noun = shop_noun(category)

    def swap(text: str) -> str:
        return text.replace("The shop", f"The {noun}").replace("the shop", f"the {noun}").replace("this shop", f"this {noun}")

    return {k: swap(v) if isinstance(v, str) else v for k, v in DEFAULT_POLICIES.items()}


def slugify(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return slug[:60] or "shop"


def _unique_slug(db: Session, name: str) -> str:
    base = slugify(name)
    slug, n = base, 2
    while db.scalar(select(Merchant.id).where(Merchant.slug == slug)):
        slug, n = f"{base}-{n}", n + 1
    return slug


# --------------------------------------------------------------------------- validation


class Address(BaseModel):
    line1: str = Field(default="", max_length=120)
    city: str = Field(default="", max_length=80)
    region: str = Field(default="", max_length=40)
    postal_code: str = Field(default="", max_length=20)
    country: str = Field(default="US", max_length=2)


class ShopProfile(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    category: str = Field(default="Bakery", min_length=2, max_length=40)
    tagline: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=1200)
    phone: str = Field(default="", max_length=40)
    support_email: EmailStr | None = None
    timezone: str = Field(default="America/Los_Angeles", max_length=64)
    address: Address = Field(default_factory=Address)


class PickupSettings(BaseModel):
    windows: dict[str, list[str] | None]
    slot_minutes: int = Field(default=30, ge=15, le=120)
    capacity: int = Field(default=6, ge=0, le=100)


class HoursBody(BaseModel):
    hours: dict[str, list[str] | None]
    pickup: PickupSettings


def _field_error(field: str, message: str) -> Unprocessable:
    return Unprocessable(message, code="validation_error", details=[{"field": field, "message": message}])


def _check_timezone(tz: str) -> None:
    if tz not in available_timezones():
        raise _field_error("timezone", "Choose a valid time zone")


def _check_week(field: str, week: dict[str, list[str] | None]) -> dict[str, list[str] | None]:
    clean: dict[str, list[str] | None] = {}
    for day in WEEKDAYS:
        value = week.get(day)
        if value is None:
            clean[day] = None
            continue
        if len(value) != 2 or not all(isinstance(v, str) and _HHMM.match(v) for v in value):
            raise _field_error(f"{field}.{day}", "Use HH:MM times")
        if value[0] >= value[1]:
            raise _field_error(f"{field}.{day}", "Must end after it starts (same day)")
        clean[day] = [value[0], value[1]]
    return clean


# --------------------------------------------------------------------------- views


def _checklist_items() -> list[tuple[str, str, Callable[[Session, Merchant], bool]]]:
    return [
        ("profile", "Shop profile and pickup address", lambda db, m: bool(m.name and m.address.get("line1") and m.address.get("city")
                                                                         and (m.phone or m.support_email))),
        ("hours", "Opening hours and pickup windows", lambda db, m: any(m.pickup_config.get("windows", {}).get(d) for d in WEEKDAYS)),
        ("policies", "Cancellation, refund and allergen policies reviewed", lambda db, m: bool(m.verification.get("policies_confirmed_at"))),
        ("payouts", "PayPal account connected for payouts", lambda db, m: (m.paypal or {}).get("status") == "connected"),
        ("catalog", "At least one product listed with a price", lambda db, m: db.scalar(
            select(Product.id).where(Product.merchant_id == m.id, Product.status == "active").limit(1)) is not None),
    ]


def checklist(db: Session, merchant: Merchant) -> list[dict[str, Any]]:
    return [{"key": key, "label": label, "done": check(db, merchant)} for key, label, check in _checklist_items()]


def shop_view(db: Session, merchant: Merchant, role: str | None = None) -> dict[str, Any]:
    items = checklist(db, merchant)
    return {
        "shop": {"id": merchant.id, "slug": merchant.slug, "name": merchant.name, "category": merchant.category, "tagline": merchant.tagline,
                 "description": merchant.description, "phone": merchant.phone, "support_email": merchant.support_email,
                 "timezone": merchant.timezone, "currency": merchant.currency, "address": merchant.address, "status": merchant.status,
                 "is_showcase": merchant.is_showcase, "review_note": merchant.review_note, "submitted_at": clock.iso(merchant.submitted_at),
                 "approved_at": clock.iso(merchant.approved_at), "verification": merchant.verification},
        "hours": merchant.hours,
        "pickup": merchant.pickup_config,
        "pickup_paused": merchant.pickup_paused,
        "payouts": payee_display(merchant.paypal or {}),
        "policies": merchant.policies,
        "policy_version": merchant.policy_version,
        "checklist": items,
        "ready_to_submit": all(i["done"] for i in items) and merchant.status in ("draft", "rejected"),
        "category_suggestions": CATEGORY_SUGGESTIONS,
        "can_edit": has_role(role, "manager") if role else False,
        "can_edit_money": has_role(role, "owner") if role else False,
    }


def _locked(db: Session, merchant_id: str) -> Merchant:
    merchant = db.scalar(select(Merchant).where(Merchant.id == merchant_id).with_for_update())
    if merchant is None:
        raise NotFound("Shop not found")
    return merchant


# --------------------------------------------------------------------------- owner actions


def create(user: SessionUser, profile: ShopProfile) -> dict[str, Any]:
    _check_timezone(profile.timezone)
    with transaction() as db:
        slug = _unique_slug(db, profile.name)
        merchant = Merchant(
            id=new_id("mer"), slug=slug, name=profile.name.strip(), category=profile.category.strip(), tagline=profile.tagline.strip(),
            description=profile.description.strip(), phone=profile.phone.strip(), support_email=str(profile.support_email or ""),
            timezone=profile.timezone, currency="USD", address=profile.address.model_dump(), hours=default_hours(),
            pickup_config=default_pickup(), policies=personalized_policies(profile.category),
            paypal={}, verification={}, status="draft",
        )
        db.add(merchant)
        db.flush()
        db.add(Membership(id=new_id("mem"), user_id=user.user_id, merchant_id=merchant.id, role="owner"))
        session = db.get(UserSession, user.session_id)
        session.active_merchant_id = merchant.id
        audit.record(db, actor=f"user:{user.user_id}", actor_role="owner", entity_type="merchant", entity_id=merchant.id, action="shop_created",
                     meta={"slug": slug})
        db.flush()
        return {"account": account_view(db, user.user_id, merchant.id), **shop_view(db, merchant, "owner")}


def get(ctx: StaffContext) -> dict[str, Any]:
    with transaction() as db:
        merchant = db.get(Merchant, ctx.merchant_id)
        return shop_view(db, merchant, ctx.role)


def update_profile(ctx: StaffContext, profile: ShopProfile) -> dict[str, Any]:
    require_role(ctx, "manager")
    _check_timezone(profile.timezone)
    with transaction() as db:
        merchant = _locked(db, ctx.merchant_id)
        if profile.timezone != merchant.timezone and merchant.status == "live":
            raise _field_error("timezone", "A live shop's time zone can't change; contact LastCall support")
        merchant.name = profile.name.strip()
        merchant.category = profile.category.strip()
        merchant.tagline = profile.tagline.strip()
        merchant.description = profile.description.strip()
        merchant.phone = profile.phone.strip()
        merchant.support_email = str(profile.support_email or "")
        merchant.timezone = profile.timezone
        merchant.address = profile.address.model_dump()
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="merchant", entity_id=merchant.id, action="profile_updated")
        return shop_view(db, merchant, ctx.role)


def update_hours(ctx: StaffContext, body: HoursBody) -> dict[str, Any]:
    require_role(ctx, "manager")
    hours = _check_week("hours", body.hours)
    windows = _check_week("pickup.windows", body.pickup.windows)
    with transaction() as db:
        merchant = _locked(db, ctx.merchant_id)
        merchant.hours = hours
        merchant.pickup_config = {"windows": windows, "slot_minutes": body.pickup.slot_minutes, "capacity": body.pickup.capacity}
        db.flush()
        pickup.rebuild_open_slots(db, merchant)
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="merchant", entity_id=merchant.id, action="hours_updated",
                     meta={"pickup": merchant.pickup_config})
        return shop_view(db, merchant, ctx.role)


def set_pickup_paused(ctx: StaffContext, paused: bool) -> dict[str, Any]:
    require_role(ctx, "manager")
    with transaction() as db:
        merchant = _locked(db, ctx.merchant_id)
        merchant.pickup_paused = paused
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="merchant", entity_id=merchant.id,
                     action="pickup_paused" if paused else "pickup_resumed")
        return shop_view(db, merchant, ctx.role)


def update_policies(ctx: StaffContext, patch: dict[str, Any]) -> dict[str, Any]:
    require_role(ctx, "manager")
    with transaction() as db:
        merchant = _locked(db, ctx.merchant_id)
        policies = {**merchant.policies}
        customer_facing = False
        if "tax_rates_bps" in patch or "fees_minor" in patch:
            require_role(ctx, "owner")
            if "tax_rates_bps" in patch:
                try:
                    rates = {str(k): int(v) for k, v in dict(patch["tax_rates_bps"]).items()}
                except (TypeError, ValueError) as exc:
                    raise _field_error("tax_rates_bps", "Tax rates must be whole basis points") from exc
                if any(v < 0 or v > 3000 for v in rates.values()):
                    raise _field_error("tax_rates_bps", "Tax rates must be between 0 and 30%")
                policies["tax_rates_bps"] = rates
            if "fees_minor" in patch:
                fee = int(patch["fees_minor"])
                if fee < 0 or fee > 1000:
                    raise _field_error("fees_minor", "Fees must be between $0 and $10")
                policies["fees_minor"] = fee
            customer_facing = True
        for key in POLICY_TEXT_KEYS:
            if key in patch:
                text = str(patch[key]).strip()
                if not text:
                    raise _field_error(key, "Required")
                policies[key] = text[:1200]
                customer_facing = True
        for key, (low, high) in POLICY_NUMBER_LIMITS.items():
            if key in patch:
                try:
                    value = int(patch[key])
                except (TypeError, ValueError) as exc:
                    raise _field_error(key, "Enter a whole number") from exc
                if not low <= value <= high:
                    raise _field_error(key, f"Must be between {low} and {high}")
                policies[key] = value
        if "no_show_policy" in patch:
            if patch["no_show_policy"] not in NO_SHOW_POLICIES:
                raise _field_error("no_show_policy", "Unknown no-show policy")
            policies["no_show_policy"] = patch["no_show_policy"]
            customer_facing = True
        for key in ("closeout_enabled", "concierge_listed"):
            if key in patch:
                if not isinstance(patch[key], bool):
                    raise _field_error(key, "Must be true or false")
                policies[key] = patch[key]
        if "relist_at_local" in patch:
            value = str(patch["relist_at_local"])
            if not _HHMM.match(value):
                raise _field_error("relist_at_local", "Use HH:MM")
            policies["relist_at_local"] = value
        if "cancellation_cutoff_minutes" in patch:
            customer_facing = True
        merchant.policies = policies
        if customer_facing:
            merchant.policy_version += 1  # shoppers must re-accept before checkout
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="merchant", entity_id=merchant.id, action="policies_updated",
                     meta={"keys": sorted(patch.keys()), "policy_version": merchant.policy_version})
        return shop_view(db, merchant, ctx.role)


def confirm_policies(ctx: StaffContext) -> dict[str, Any]:
    require_role(ctx, "owner")
    with transaction() as db:
        merchant = _locked(db, ctx.merchant_id)
        merchant.verification = {**merchant.verification, "policies_confirmed_at": clock.iso(clock.now()),
                                 "policies_confirmed_by": ctx.display_name, "policies_version": merchant.policy_version}
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="merchant", entity_id=merchant.id, action="policies_confirmed")
        return shop_view(db, merchant, ctx.role)


def submit(ctx: StaffContext) -> dict[str, Any]:
    require_role(ctx, "owner")
    with transaction() as db:
        merchant = _locked(db, ctx.merchant_id)
        if merchant.status not in ("draft", "rejected"):
            raise Conflict("This shop has already been submitted", code="already_submitted")
        missing = [i["label"] for i in checklist(db, merchant) if not i["done"]]
        if missing:
            raise Unprocessable("Finish setup before submitting", code="setup_incomplete", details={"missing": missing})
        merchant.status = "pending_review"
        merchant.submitted_at = clock.now()
        merchant.review_note = None
        for admin in db.scalars(select(User).where(User.is_platform_admin.is_(True), User.active.is_(True))).all():
            mail.queue(db, to=admin.email, template="shop_submitted", link=mail.app_link(f"/ops/shops/{merchant.id}"),
                       context={"shop": merchant.name, "owner": ctx.display_name})
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="merchant", entity_id=merchant.id, action="shop_submitted")
        return shop_view(db, merchant, ctx.role)


# --------------------------------------------------------------------------- platform review


def _owner_emails(db: Session, merchant_id: str) -> list[str]:
    return list(db.scalars(select(User.email).join(Membership, Membership.user_id == User.id)
                           .where(Membership.merchant_id == merchant_id, Membership.role == "owner")).all())


def review_queue(status: str | None) -> dict[str, Any]:
    with transaction() as db:
        stmt = select(Merchant).order_by(Merchant.submitted_at.desc().nullslast(), Merchant.created_at.desc())
        if status:
            stmt = stmt.where(Merchant.status == status)
        rows = db.scalars(stmt).all()
        return {"shops": [{"id": m.id, "slug": m.slug, "name": m.name, "category": m.category, "status": m.status,
                           "city": m.address.get("city", ""), "is_showcase": m.is_showcase, "submitted_at": clock.iso(m.submitted_at),
                           "owners": _owner_emails(db, m.id)} for m in rows],
                "approval_checks": APPROVAL_CHECKS}


def review_detail(merchant_id: str) -> dict[str, Any]:
    with transaction() as db:
        merchant = db.get(Merchant, merchant_id)
        if merchant is None:
            raise NotFound("Shop not found")
        return {**shop_view(db, merchant), "owners": _owner_emails(db, merchant.id), "approval_checks": APPROVAL_CHECKS}


def _decide(admin: SessionUser, merchant_id: str, *, allowed_from: tuple[str, ...], to: str, action: str,
            note: str | None = None, checks: list[str] | None = None) -> dict[str, Any]:
    with transaction() as db:
        merchant = _locked(db, merchant_id)
        if merchant.status not in allowed_from:
            raise Conflict(f"A {merchant.status.replace('_', ' ')} shop can't be {action}", code="invalid_transition")
        merchant.status = to
        merchant.review_note = note
        if to == "live":
            merchant.approved_at = clock.now()
            merchant.verification = {**merchant.verification, "verified_by": "LastCall", "verified_at": clock.local_date(merchant.timezone).isoformat(),
                                     "checks": checks or APPROVAL_CHECKS}
        template = {"live": "shop_approved", "rejected": "shop_rejected", "suspended": "shop_suspended"}.get(to)
        if template:
            for email in _owner_emails(db, merchant.id):
                mail.queue(db, to=email, template=template, link=mail.app_link("/merchant"), context={"shop": merchant.name, "note": note or ""})
        audit.record(db, actor=f"admin:{admin.email}", actor_role="platform_admin", entity_type="merchant", entity_id=merchant.id,
                     action=f"shop_{action}", meta={"note": note, "checks": checks})
        return {**shop_view(db, merchant), "owners": _owner_emails(db, merchant.id), "approval_checks": APPROVAL_CHECKS}


def approve(admin: SessionUser, merchant_id: str, checks: list[str]) -> dict[str, Any]:
    unknown = [c for c in checks if c not in APPROVAL_CHECKS]
    if unknown or set(checks) != set(APPROVAL_CHECKS):
        raise Unprocessable("Confirm every approval check before approving", code="checks_incomplete")
    return _decide(admin, merchant_id, allowed_from=("pending_review",), to="live", action="approved", checks=checks)


def reject(admin: SessionUser, merchant_id: str, note: str) -> dict[str, Any]:
    return _decide(admin, merchant_id, allowed_from=("pending_review",), to="rejected", action="rejected", note=note)


def suspend(admin: SessionUser, merchant_id: str, note: str) -> dict[str, Any]:
    return _decide(admin, merchant_id, allowed_from=("live",), to="suspended", action="suspended", note=note)


def reinstate(admin: SessionUser, merchant_id: str) -> dict[str, Any]:
    return _decide(admin, merchant_id, allowed_from=("suspended",), to="live", action="reinstated")
