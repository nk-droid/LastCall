"""Showcase shops: the curated, fictional shops a fresh deployment opens with.

``python -m app.cli seed-showcase`` creates them once (it never touches an existing shop), each
live and verified, with today's surplus listed and its daily listing template switched on so it
stays stocked. Staff accounts are created only when SHOWCASE_PASSWORD is set; a shop's payout
account comes from SHOWCASE_PAYEE_<SLUG> (its PayPal Sandbox business account merchant ID).

Photos come from a folder of ``<slug>/<SKU>.jpg|png|webp`` files with a ``credits.json``. The
bundled set (``PHOTOS``) is openly licensed from Wikimedia Commons; each photo's credit is stored
with it and listed on the public Photo credits page.
"""

from __future__ import annotations

import json
import os
from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.ids import new_id
from app.models import InventoryEvent, InventoryLot, Membership, Merchant, Price, Product, User
from app.payments.payee import MERCHANT_ID
from app.security import hash_password
from app.seed.catalogs import COPPER_CATALOG, GOLDEN_CATALOG, JUNIPER_CATALOG, NIGHT_OWL_CATALOG
from app.services import audit, media, pickup, shops

REFERENCE_SOURCE = "Regular menu price for the same item (in-store menu board)"
PHOTOS = Path(__file__).parent / "photos"
WEEK = shops.WEEKDAYS


def _week(window: tuple[str, str] | None, closed: tuple[str, ...] = ()) -> dict[str, list[str] | None]:
    return {d: (None if d in closed or window is None else list(window)) for d in WEEK}


SHOWCASE: list[dict[str, Any]] = [
    dict(slug="juniper-rye", name="Juniper & Rye Bakehouse", category="Bakery", tagline="Neighborhood sourdough and pastry, baked daily",
         description="A small neighborhood bakery. Each afternoon it lists what's left from the day's bake for pickup at a lower price.",
         address={"line1": "418 Alder Street", "city": "Fernhill", "region": "CA", "postal_code": "94110", "country": "US"},
         phone="(415) 555-0148", hours=_week(("07:00", "19:00")), pickup=_week(("16:00", "19:00")), capacity=6, relist_at="06:00",
         policies={}, catalog=JUNIPER_CATALOG,
         staff=[("owner", "Morgan Lee"), ("manager", "Sam Ortiz"), ("staff", "Jordan Kim")]),
    dict(slug="copper-kettle", name="Copper Kettle Café", category="Café", tagline="Bagels, quiche and cake from an all-day café",
         description="A neighborhood café. Lunch leftovers and the afternoon's bakes go up for pickup before close.",
         address={"line1": "77 Mill Road", "city": "Riverside", "region": "CA", "postal_code": "94117", "country": "US"},
         phone="(415) 555-0172", hours=_week(("07:30", "18:00"), closed=("sun",)), pickup=_week(("14:00", "18:00"), closed=("sun",)), capacity=5,
         relist_at="06:30",
         policies={"cancellation_cutoff_minutes": 30, "max_units_per_order": 10, "no_show_grace_minutes": 20,
                   "cancellation_policy_text": "You can request a cancellation up to 30 minutes before your pickup window starts. The café reviews each request; approved cancellations are refunded in full to your PayPal payment method.",
                   "cross_contact_text": "Our café kitchen handles peanuts, tree nuts, sesame and wheat on shared counters. Cross-contact can't be ruled out.",
                   "pickup_instructions": "Pick up at the end of the coffee bar; the barista will ask for your pickup code."},
         catalog=COPPER_CATALOG, staff=[("owner", "Priya Nair"), ("manager", "Diego Alvarez"), ("staff", "Riley Chen")]),
    dict(slug="golden-bun", name="Golden Bun Bakery", category="Asian bakery", tagline="Hong Kong–style buns, egg tarts and milk bread",
         description="An Asian bakery. Evening surplus from the day's buns and tarts, ready for pickup.",
         address={"line1": "1208 Harbor Way", "city": "Bayview", "region": "CA", "postal_code": "94124", "country": "US"},
         phone="(415) 555-0193", hours=_week(("08:00", "21:00")), pickup=_week(("17:00", "21:00")), capacity=8, relist_at="07:00",
         policies={"cancellation_cutoff_minutes": 45, "max_units_per_order": 16,
                   "cancellation_policy_text": "You can request a cancellation up to 45 minutes before your pickup window starts. The bakery reviews each request; approved cancellations are refunded in full to your PayPal payment method.",
                   "cross_contact_text": "Our kitchen uses peanuts, sesame and soy every day. We separate trays for verified items, but cross-contact can never be fully ruled out.",
                   "pickup_instructions": "Pick up at the front counter; show your pickup code to the cashier."},
         catalog=GOLDEN_CATALOG, staff=[("owner", "Wei Lin"), ("manager", "Mei Tan"), ("staff", "Kai Wong")]),
    dict(slug="night-owl", name="Night Owl Doughnuts", category="Doughnut shop", tagline="Open 24 hours. Fresh rings around the clock",
         description="A 24-hour doughnut counter. Whatever's left from each fry goes up for pickup, day or night.",
         address={"line1": "2290 Mission Street", "city": "Mission Flats", "region": "CA", "postal_code": "94110", "country": "US"},
         phone="(415) 555-0126", hours=_week(("00:00", "23:59")), pickup=_week(("00:00", "23:59")), capacity=6, slot_minutes=15, relist_at="00:05",
         policies={"cancellation_cutoff_minutes": 15, "no_show_grace_minutes": 60, "min_lead_minutes": 10,
                   "cross_contact_text": "Every doughnut is fried in shared oil with our peanut butter doughnuts, and toppings include tree nuts. Cross-contact can't be ruled out.",
                   "pickup_instructions": "Show your pickup code at the register; your box waits on the LastCall shelf."},
         catalog=NIGHT_OWL_CATALOG, staff=[("owner", "Ava Brooks"), ("manager", "Theo Grant"), ("staff", "Luz Ramirez")]),
]


def staff_email(slug: str, role: str) -> str:
    return f"{slug.replace('-', '')}.{role}@example.com"


def _payee(slug: str) -> dict[str, Any]:
    merchant_id = (os.environ.get(f"SHOWCASE_PAYEE_{slug.replace('-', '_').upper()}") or "").strip().upper()
    if merchant_id and MERCHANT_ID.match(merchant_id):
        return {"merchant_id": merchant_id, "status": "connected", "verified_at": clock.iso(clock.now()), "connected_by": "seed"}
    return {}


def _create_shop(db: Session, spec: dict[str, Any], now) -> Merchant:
    tz = "America/Los_Angeles"
    policies = {**shops.personalized_policies(spec["category"]), **spec["policies"], "relist_at_local": spec["relist_at"]}
    merchant = Merchant(
        id=new_id("mer"), slug=spec["slug"], name=spec["name"], category=spec["category"], tagline=spec["tagline"], description=spec["description"],
        address=spec["address"], phone=spec["phone"], support_email=f"hello.{spec['slug'].replace('-', '')}@example.com", timezone=tz,
        currency="USD", hours=spec["hours"],
        pickup_config={"windows": spec["pickup"], "slot_minutes": spec.get("slot_minutes", 30), "capacity": spec["capacity"]},
        policies=policies, paypal=_payee(spec["slug"]), status="live", is_showcase=True, submitted_at=now, approved_at=now,
        verification={"verified_by": "LastCall", "verified_at": clock.local_date(tz).isoformat(), "checks": shops.APPROVAL_CHECKS,
                      "policies_confirmed_at": clock.iso(now), "policies_confirmed_by": spec["staff"][0][1]},
    )
    db.add(merchant)
    db.flush()
    today = clock.local_date(tz)
    window = pickup.window_for(merchant, today) or ("16:00", "19:00")
    end_dt = clock.combine_local(today, window[1], tz)
    for item in spec["catalog"]:
        verified = item["status"] == "verified"
        product = Product(
            id=new_id("prd"), merchant_id=merchant.id, sku=item["sku"], name=item["name"], description=item["description"], category=item["category"],
            attributes={"flavor": item["flavor"], "servings_per_unit": item["servings"], "tags": item["tags"], "dietary": item["dietary"],
                        "ingredients": item["ingredients"]},
            allergens={"contains": sorted(item["contains"]), "cross_contact": sorted(item["cross"]), "status": item["status"],
                       "verified_by": spec["staff"][0][1] if verified else None, "verified_at": today.isoformat() if verified else None,
                       "notes": item.get("notes", "")},
            allergen_source={"verified": "merchant_verified", "needs_review": "merchant_unverified"}.get(item["status"], "missing"),
            status="paused" if item.get("paused") else "active", per_order_limit=6, surplus_priority=item["priority"],
            relist_daily=not item.get("paused"), relist_qty=item["surplus"],
            relist_cutoff_local=clock.hhmm(end_dt + timedelta(minutes=item["cutoff_offset"]), tz),
        )
        db.add(product)
        db.flush()
        db.add(Price(id=new_id("prc"), product_id=product.id, sku=item["sku"], currency="USD", reference_minor=item["reference"],
                     sale_minor=item["sale"], reference_source=REFERENCE_SOURCE, effective_at=now - timedelta(hours=8), created_by="seed"))
        db.add(InventoryLot(id=new_id("lot"), product_id=product.id, on_hand=item["surplus"], surplus_qty=item["surplus"], buffer_qty=0,
                            cutoff_at=end_dt + timedelta(minutes=item["cutoff_offset"]), updated_by="seed", updated_at=now))
        db.add(InventoryEvent(merchant_id=merchant.id, product_id=product.id, sku=item["sku"], event_type="LISTED", delta=item["surplus"],
                              surplus_before=0, surplus_after=item["surplus"], actor="seed", reason="Today's surplus listed", created_at=now))
    pickup.ensure_slots(db, merchant, now)
    return merchant


def _create_staff(db: Session, merchant: Merchant, spec: dict[str, Any], password: str) -> list[str]:
    created = []
    for role, name in spec["staff"]:
        email = staff_email(spec["slug"], role)
        user = db.scalar(select(User).where(User.email == email))
        if user is None:
            user = User(id=new_id("usr"), email=email, display_name=name, password_hash=hash_password(password))
            db.add(user)
            db.flush()
        if db.scalar(select(Membership.id).where(Membership.user_id == user.id, Membership.merchant_id == merchant.id)) is None:
            db.add(Membership(id=new_id("mem"), user_id=user.id, merchant_id=merchant.id, role=role))
        created.append(email)
    return created


# --------------------------------------------------------------------------- photos


def _folder_photos(db: Session, merchant: Merchant, folder: Path) -> int:
    credits = {}
    if (folder / "credits.json").exists():
        credits = json.loads((folder / "credits.json").read_text())
    attached = 0
    for product in db.scalars(select(Product).where(Product.merchant_id == merchant.id, Product.image_url.is_(None))).all():
        for ext in ("jpg", "jpeg", "png", "webp"):
            path = folder / merchant.slug / f"{product.sku}.{ext}"
            if path.exists():
                credit = credits.get(f"{merchant.slug}/{product.sku}", {})
                asset = media.store(db, path.read_bytes(), filename=path.name, merchant_id=None, actor="seed", attribution=credit)
                product.image_url = media.url(asset.id)
                attached += 1
                break
    return attached


# --------------------------------------------------------------------------- entry point


def seed(*, password: str | None = None, photos: Path | None = None) -> dict[str, Any]:
    """Create any showcase shop that doesn't exist yet; attach photos to products that have none."""
    now = clock.now()
    result: dict[str, Any] = {"created": [], "existing": [], "staff": {}, "photos": 0}
    with transaction() as db:
        for spec in SHOWCASE:
            merchant = db.scalar(select(Merchant).where(Merchant.slug == spec["slug"]))
            if merchant is None:
                merchant = _create_shop(db, spec, now)
                audit.record(db, actor="system:seed", actor_role="system", entity_type="merchant", entity_id=merchant.id, action="showcase_created")
                result["created"].append(spec["slug"])
            else:
                result["existing"].append(spec["slug"])
            if password:
                result["staff"][spec["slug"]] = _create_staff(db, merchant, spec, password)
            if photos:
                result["photos"] += _folder_photos(db, merchant, photos)
    return result
