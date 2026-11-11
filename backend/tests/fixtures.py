"""A realistic bakery catalog for tests: the specification's Appendix A items plus the
products that exercise dietary filtering (nut items, cross-contact, unverified allergens)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from app import clock
from app.db import transaction
from app.ids import new_id
from app.models import InventoryEvent, InventoryLot, Merchant, Price, Product
from app.seed.catalogs import JUNIPER_CATALOG
from app.services import pickup, shops

REFERENCE_SOURCE = "Regular menu price for the same item (in-store menu board)"

def seed_bakery(slug: str = "juniper-rye", name: str = "Juniper & Rye Bakehouse", status: str = "live",
                tz: str = "America/Los_Angeles", window: tuple[str, str] = ("16:00", "19:00"),
                catalog: list[dict[str, Any]] | None = None) -> str:
    """Create a shop with today's surplus listed and pickup slots generated. Returns the merchant id."""
    now = clock.now()
    with transaction() as db:
        merchant = Merchant(
            id=new_id("mer"), slug=slug, name=name, category="Bakery", tagline="Neighborhood sourdough and pastry, baked daily",
            description="A neighborhood bakery listing what's left from the day's bake.", timezone=tz, currency="USD", status=status,
            address={"line1": "418 Alder Street", "city": "Fernhill", "region": "CA", "postal_code": "94000", "country": "US"},
            phone="(555) 010-2468", support_email=f"hello@{slug}.com", hours={d: ["07:00", window[1]] for d in shops.WEEKDAYS},
            pickup_config={"windows": {d: list(window) for d in shops.WEEKDAYS}, "slot_minutes": 30, "capacity": 6},
            policies=shops.personalized_policies("Bakery"), paypal={},
            verification={"verified_by": "LastCall", "verified_at": clock.local_date(tz).isoformat(), "checks": shops.APPROVAL_CHECKS,
                          "policies_confirmed_at": clock.iso(now)},
        )
        db.add(merchant)
        db.flush()
        today = clock.local_date(tz)
        end_dt = clock.combine_local(today, window[1], tz)
        for item in catalog or JUNIPER_CATALOG:
            verified = item["status"] == "verified"
            product = Product(
                id=new_id("prd"), merchant_id=merchant.id, sku=item["sku"], name=item["name"], description=item["description"],
                category=item["category"],
                attributes={"flavor": item["flavor"], "servings_per_unit": item["servings"], "tags": item["tags"], "dietary": item["dietary"],
                            "ingredients": item["ingredients"]},
                allergens={"contains": sorted(item["contains"]), "cross_contact": sorted(item["cross"]), "status": item["status"],
                           "verified_by": "Morgan Lee (owner)" if verified else None, "verified_at": today.isoformat() if verified else None,
                           "notes": item.get("notes", "")},
                allergen_source={"verified": "merchant_verified", "needs_review": "merchant_unverified"}.get(item["status"], "missing"),
                status="paused" if item.get("paused") else "active", per_order_limit=6, surplus_priority=item["priority"],
                image_url=f"/api/assets/img_fixture_{item['sku'].lower()}",
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
        return merchant.id
