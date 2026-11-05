"""A realistic bakery catalog for tests: the specification's Appendix A items plus the
products that exercise dietary filtering (nut items, cross-contact, unverified allergens)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from app import clock
from app.db import transaction
from app.ids import new_id
from app.models import InventoryEvent, InventoryLot, Merchant, Price, Product
from app.services import pickup, shops

REFERENCE_SOURCE = "Regular menu price for the same item (in-store menu board)"

JUNIPER_CATALOG: list[dict[str, Any]] = [
    dict(sku="CR-01", name="Butter croissant", category="pastry", flavor="sweet", servings=1, tags=["handheld", "breakfast"], surplus=8,
         reference=400, sale=250, contains=["wheat", "milk"], cross=[], status="verified", cutoff_offset=-30, priority=2,
         dietary={"vegetarian": True, "vegan": False}, ingredients="Wheat flour, butter (milk), water, sugar, yeast, salt",
         description="Laminated by hand this morning; crisp outside, soft honeycomb inside."),
    dict(sku="BR-02", name="Sourdough roll", category="bread", flavor="savory", servings=1, tags=["handheld", "dinner"], surplus=10,
         reference=300, sale=200, contains=["wheat"], cross=[], status="verified", cutoff_offset=0, priority=1,
         dietary={"vegetarian": True, "vegan": True}, ingredients="Wheat flour, water, salt, sourdough culture",
         description="Long-fermented roll with a blistered crust."),
    dict(sku="MU-03", name="Berry muffin", category="pastry", flavor="sweet", servings=1, tags=["handheld", "breakfast", "fruit", "kid_friendly"], surplus=5,
         reference=450, sale=300, contains=["wheat", "milk", "eggs"], cross=[], status="needs_review", cutoff_offset=0, priority=2,
         dietary={"vegetarian": True, "vegan": False}, ingredients="Wheat flour, berries, sugar, eggs, milk, butter, baking powder",
         description="Mixed-berry muffin with a crumb top.",
         notes="Berry compote supplier changed; allergen spec sheet awaiting review."),
    dict(sku="SC-04", name="Savory scone", category="savory", flavor="savory", servings=1, tags=["handheld", "breakfast"], surplus=6,
         reference=400, sale=275, contains=["wheat", "milk"], cross=[], status="verified", cutoff_offset=0, priority=2,
         dietary={"vegetarian": True, "vegan": False}, ingredients="Wheat flour, cheddar (milk), butter (milk), chives, baking powder, salt",
         description="Cheddar and chive scone, best warmed for a few minutes."),
    dict(sku="FT-05", name="Fruit tart", category="pastry", flavor="sweet", servings=1, tags=["dessert", "fruit"], surplus=2,
         reference=550, sale=350, contains=["wheat", "milk", "eggs"], cross=[], status="verified", cutoff_offset=-30, priority=3,
         dietary={"vegetarian": True, "vegan": False}, ingredients="Wheat flour, butter (milk), eggs, sugar, vanilla custard (milk, eggs), seasonal fruit",
         description="Shortcrust tart with vanilla custard and seasonal fruit."),
    dict(sku="AC-06", name="Almond croissant", category="pastry", flavor="sweet", servings=1, tags=["handheld", "breakfast"], surplus=6,
         reference=475, sale=300, contains=["tree_nuts", "wheat", "milk", "eggs"], cross=[], status="verified", cutoff_offset=-30, priority=2,
         dietary={"vegetarian": True, "vegan": False},
         ingredients="Wheat flour, butter (milk), almond frangipane (almonds, eggs, sugar), sliced almonds",
         description="Twice-baked with almond frangipane."),
    dict(sku="CB-07", name="Cinnamon bun", category="pastry", flavor="sweet", servings=1, tags=["breakfast", "kid_friendly", "shareable"], surplus=6,
         reference=425, sale=275, contains=["wheat", "milk", "eggs"], cross=["tree_nuts"], status="verified", cutoff_offset=0, priority=2,
         dietary={"vegetarian": True, "vegan": False},
         ingredients="Wheat flour, milk, butter (milk), eggs, brown sugar, cinnamon",
         description="Soft cardamom-cinnamon swirl. Baked on trays shared with our pecan sticky buns."),
    dict(sku="FO-08", name="Rosemary focaccia (half slab)", category="bread", flavor="savory", servings=4, tags=["shareable", "dinner"], surplus=3,
         reference=900, sale=500, contains=["wheat"], cross=[], status="verified", cutoff_offset=0, priority=1,
         dietary={"vegetarian": True, "vegan": True}, ingredients="Wheat flour, olive oil, water, rosemary, sea salt, yeast",
         description="Dimpled, olive-oil rich focaccia that serves about four."),
    dict(sku="BA-09", name="Country baguette", category="bread", flavor="savory", servings=3, tags=["shareable", "dinner"], surplus=4,
         reference=450, sale=275, contains=["wheat"], cross=[], status="verified", cutoff_offset=0, priority=1,
         dietary={"vegetarian": True, "vegan": True}, ingredients="Wheat flour, water, salt, yeast",
         description="Crackly crust, open crumb."),
    dict(sku="CC-10", name="Chocolate chip cookie", category="cookie", flavor="sweet", servings=1, tags=["handheld", "chocolate", "kid_friendly", "dessert"], surplus=12,
         reference=250, sale=150, contains=["wheat", "milk", "eggs", "soy"], cross=[], status="verified", cutoff_offset=0, priority=1,
         dietary={"vegetarian": True, "vegan": False}, ingredients="Wheat flour, butter (milk), brown sugar, eggs, dark chocolate (soy lecithin), sea salt",
         description="Brown-butter cookie with dark chocolate chunks."),
    dict(sku="BB-11", name="Banana walnut bread (slice)", category="cake", flavor="sweet", servings=1, tags=["breakfast"], surplus=6,
         reference=375, sale=225, contains=["tree_nuts", "wheat", "eggs", "milk"], cross=[], status="verified", cutoff_offset=0, priority=2,
         dietary={"vegetarian": True, "vegan": False}, ingredients="Bananas, wheat flour, walnuts, eggs, butter (milk), sugar",
         description="Thick slice of banana bread with toasted walnuts."),
    dict(sku="SF-12", name="Spinach & feta hand pie", category="savory", flavor="savory", servings=1, tags=["handheld", "dinner"], surplus=4,
         reference=550, sale=325, contains=["wheat", "milk", "eggs"], cross=[], status="verified", cutoff_offset=0, priority=2,
         dietary={"vegetarian": True, "vegan": False}, ingredients="Wheat flour, spinach, feta (milk), eggs, butter (milk), dill",
         description="Flaky pastry filled with spinach, feta and dill."),
    dict(sku="RY-13", name="Seeded rye loaf", category="bread", flavor="savory", servings=6, tags=["shareable"], surplus=2,
         reference=800, sale=450, contains=["wheat", "sesame"], cross=[], status="verified", cutoff_offset=0, priority=1,
         dietary={"vegetarian": True, "vegan": True}, ingredients="Rye and wheat flour, sunflower seeds, sesame seeds, water, salt",
         description="Dense, seeded rye. Listing paused while we re-weigh loaves.", paused=True),
]


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
