"""Storefront visibility, catalog read model, pickup slots and inventory management."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select

from app import clock
from app.db import transaction
from app.models import InventoryEvent, MerchantAlert
from app.services import inventory, shops

from .conftest import new_client
from .factories import member_client
from .fixtures import seed_bakery
from .helpers import buy, ok, shop_id, upload_photo

NEW_PRODUCT = {
    "sku": "PB-20", "name": "Pumpkin bread (slice)", "category": "cake", "flavor": "sweet", "servings_per_unit": 1, "tags": ["breakfast"],
    "ingredients": "Pumpkin, wheat flour, eggs, sugar, butter (milk), spices", "dietary": {"vegetarian": True},
    "allergens": {"contains": ["wheat", "eggs", "milk"], "cross_contact": [], "status": "verified"},
    "per_order_limit": 4, "surplus_priority": 2, "surplus": 5, "reference_minor": 400, "sale_minor": 250,
    "reference_source": "Regular menu price", "cutoff_local": "19:00",
}


def _row(rows: list[dict], sku: str) -> dict:
    return next(r for r in rows if r["sku"] == sku)


def test_directory_lists_only_live_shops(client):
    seed_bakery()
    seed_bakery(slug="draft-shop", name="Draft Shop", status="draft")
    shops_listed = client.get("/api/merchants").json()["merchants"]
    assert [m["slug"] for m in shops_listed] == ["juniper-rye"]
    card = shops_listed[0]
    assert card["pickup"]["state"] == "open" and card["surplus"]["items_available"] == 12  # paused rye is not sellable
    assert card["max_saving_percent"] == 44 and card["from_minor"] == 150
    assert client.get("/api/merchants/draft-shop").status_code == 404


def test_members_can_preview_their_unlisted_shop(app):
    shop = seed_bakery(slug="preview-shop", name="Preview Shop", status="pending_review")
    member, _ = member_client(app, shop, "staff")
    view = member.get("/api/merchants/preview-shop").json()
    assert view["preview"] is True and view["name"] == "Preview Shop"
    assert member.get("/api/merchants/preview-shop/catalog").status_code == 200
    assert new_client(app).get("/api/merchants/preview-shop/catalog").status_code == 404


def test_catalog_items_carry_price_allergen_and_availability_provenance(client):
    seed_bakery()
    items = {i["sku"]: i for i in client.get("/api/merchants/juniper-rye/catalog").json()["items"]}
    croissant = items["CR-01"]
    assert croissant["price"] == {"currency": "USD", "reference_minor": 400, "sale_minor": 250, "discount_minor": 150, "discount_pct": 38,
                                  "reference_source": "Regular menu price for the same item (in-store menu board)"}
    assert croissant["allergens"]["status"] == "verified" and croissant["allergens"]["contains"] == ["milk", "wheat"]
    assert croissant["availability"]["available"] == 8 and croissant["availability"]["status"] == "available"
    assert items["MU-03"]["allergens"]["status"] == "needs_review"
    assert items["FT-05"]["availability"]["status"] == "low"
    assert "RY-13" not in items  # paused listing hidden from shoppers
    assert croissant["image"] == {"url": "/api/assets/img_fixture_cr-01", "alt": "Photo of Butter croissant"}


def test_pickup_slots_follow_each_days_window(client, app):
    shop = seed_bakery()
    slots = client.get("/api/merchants/juniper-rye/pickup-slots").json()["slots"]
    today = [s for s in slots if s["label"].startswith("Today")]
    assert [s["start_local"] for s in today] == ["16:00", "16:30", "17:00", "17:30", "18:00", "18:30"]
    assert all(s["bookable"] for s in today)
    owner, _ = member_client(app, shop, "owner")
    windows = {d: ["16:00", "19:00"] for d in shops.WEEKDAYS} | {"wed": None, "tue": ["17:00", "18:00"]}
    saved = owner.put("/api/merchant/shop/hours", json={"hours": {d: ["07:00", "19:00"] for d in shops.WEEKDAYS},
                                                       "pickup": {"windows": windows, "slot_minutes": 30, "capacity": 3}})
    assert saved.status_code == 200
    slots = client.get("/api/merchants/juniper-rye/pickup-slots").json()["slots"]
    assert [s["start_local"] for s in slots] == ["17:00", "17:30"]  # Tuesday's new window; closed Wednesday
    assert all(s["capacity"] == 3 for s in slots)


def test_pickup_status_reports_closed_and_paused(client, app):
    shop = seed_bakery()
    clock.advance(timedelta(hours=4))  # 7 PM: today's window is over
    card = client.get("/api/merchants").json()["merchants"][0]
    assert card["pickup"]["state"] == "closed_for_today" and card["pickup"]["next_slot"]["label"].startswith("Tomorrow")
    owner, _ = member_client(app, shop, "manager")
    owner.put("/api/merchant/shop/pickup-paused", json={"paused": True})
    assert client.get("/api/merchants/juniper-rye").json()["pickup"]["state"] == "paused"


def test_staff_adjusts_stock_with_events_and_version_check(app):
    shop = seed_bakery()
    staff, _ = member_client(app, shop, "staff")
    rows = staff.get("/api/merchant/inventory").json()["rows"]
    croissant = _row(rows, "CR-01")
    sold = staff.post("/api/merchant/inventory", json={"product_id": croissant["product_id"], "action": "counter_sale", "delta": 3,
                                                       "expected_version": croissant["version"]}).json()["row"]
    assert sold["surplus"] == 5 and sold["available"] == 5
    stale = staff.post("/api/merchant/inventory", json={"product_id": croissant["product_id"], "action": "adjust", "delta": 1,
                                                        "expected_version": croissant["version"]})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "version_conflict"
    negative = staff.post("/api/merchant/inventory", json={"product_id": croissant["product_id"], "action": "set", "value": -1})
    assert negative.status_code == 422
    assert staff.post("/api/merchant/inventory", json={"product_id": croissant["product_id"], "action": "pause"}).status_code == 403
    with transaction() as db:
        events = db.scalars(select(InventoryEvent.event_type).where(InventoryEvent.product_id == croissant["product_id"])
                            .order_by(InventoryEvent.id)).all()
    assert events == ["LISTED", "COUNTER_SALE"]
    history = staff.get(f"/api/merchant/products/{croissant['product_id']}/history").json()
    assert history["inventory_events"][0]["type"] == "COUNTER_SALE"


def test_selling_out_hides_item_from_sellable_count(client, app):
    shop = seed_bakery()
    staff, _ = member_client(app, shop, "staff")
    tart = _row(staff.get("/api/merchant/inventory").json()["rows"], "FT-05")
    staff.post("/api/merchant/inventory", json={"product_id": tart["product_id"], "action": "set", "value": 0})
    items = {i["sku"]: i for i in client.get("/api/merchants/juniper-rye/catalog").json()["items"]}
    assert items["FT-05"]["availability"]["status"] == "sold_out"
    assert client.get("/api/merchants").json()["merchants"][0]["surplus"]["items_available"] == 11


def test_manager_creates_product_and_prices_never_invent_savings(app):
    shop = seed_bakery()
    manager, _ = member_client(app, shop, "manager")
    staff, _ = member_client(app, shop, "staff")
    assert staff.post("/api/merchant/products", json=NEW_PRODUCT).status_code == 403
    new_product = {**NEW_PRODUCT, "image_url": upload_photo(manager)}
    created = manager.post("/api/merchant/products", json=new_product)
    assert created.status_code == 201
    row = created.json()["row"]
    assert row["available"] == 5 and row["allergens"]["verified_by"] == "Manager Person"
    assert manager.post("/api/merchant/products", json=new_product).json()["error"]["code"] == "duplicate_sku"
    inverted = manager.post(f"/api/merchant/products/{row['product_id']}/price",
                            json={"reference_minor": 200, "sale_minor": 300, "reference_source": "Menu board"})
    assert inverted.status_code == 422 and inverted.json()["error"]["code"] == "invalid_price"
    repriced = manager.post(f"/api/merchant/products/{row['product_id']}/price",
                            json={"reference_minor": 400, "sale_minor": 200, "reference_source": "Menu board"}).json()["row"]
    assert repriced["price"]["sale_minor"] == 200
    unknown_allergen = manager.post("/api/merchant/products", json={**new_product, "sku": "PB-21",
                                                                    "allergens": {"contains": ["glitter"], "cross_contact": [], "status": "verified"}})
    assert unknown_allergen.status_code == 422


def test_archiving_removes_listing(app, client):
    shop = seed_bakery()
    manager, _ = member_client(app, shop, "manager")
    scone = _row(manager.get("/api/merchant/inventory").json()["rows"], "SC-04")
    assert manager.post("/api/merchant/inventory", json={"product_id": scone["product_id"], "action": "archive"}).json()["row"]["status"] == "archived"
    assert "SC-04" not in {r["sku"] for r in manager.get("/api/merchant/inventory").json()["rows"]}
    assert "SC-04" not in {i["sku"] for i in client.get("/api/merchants/juniper-rye/catalog").json()["items"]}


def test_monitor_raises_stale_and_low_stock_alerts(app):
    shop = seed_bakery()
    clock.advance(timedelta(minutes=241))  # counts older than the shop's stale threshold
    inventory.monitor_inventory()
    with transaction() as db:
        kinds = {a.kind for a in db.scalars(select(MerchantAlert).where(MerchantAlert.merchant_id == shop)).all()}
    assert {"stale_inventory", "low_stock"} <= kinds
    staff, _ = member_client(app, shop, "staff")
    listed = staff.get("/api/merchant/inventory").json()
    stale = next(a for a in listed["alerts"] if a["kind"] == "stale_inventory")
    assert staff.post(f"/api/merchant/alerts/{stale['id']}/resolve").json() == {"status": "resolved"}


def test_manager_closes_a_slot(app, client):
    shop = seed_bakery()
    manager, _ = member_client(app, shop, "manager")
    slot = manager.get("/api/merchant/slots").json()["slots"][0]
    closed = manager.put(f"/api/merchant/slots/{slot['id']}", json={"status": "closed"}).json()
    assert closed["bookable"] is False and closed["unavailable_reason"] == "This pickup slot was closed by the merchant"
    other = seed_bakery(slug="copper-kettle", name="Copper Kettle Café")
    assert other and manager.put(f"/api/merchant/slots/{slot['id']}", json={"capacity": 2}).status_code == 200
    foreign = client.get("/api/merchants/copper-kettle/pickup-slots").json()["slots"][0]
    assert manager.put(f"/api/merchant/slots/{foreign['id']}", json={"capacity": 2}).status_code == 404


def test_count_is_right_clears_a_stale_count_and_rows_show_todays_sales(client, app, bakery):
    buy(client, [("CR-01", 2)])
    staff = member_client(app, shop_id(), "staff")[0]
    clock.advance(timedelta(hours=5))
    listing = ok(staff.get("/api/merchant/inventory"))
    row = next(r for r in listing["rows"] if r["sku"] == "CR-01")
    assert row["stale"] and row["sold_today"] == 2
    assert listing["schedule"]["pickup_until_label"]
    after = ok(staff.post("/api/merchant/inventory", json={"product_id": row["product_id"], "action": "confirm", "expected_version": row["version"]}))["row"]
    assert not after["stale"] and after["surplus"] == row["surplus"] and after["version"] == row["version"] + 1
    with transaction() as db:
        event = db.scalars(select(InventoryEvent).where(InventoryEvent.product_id == row["product_id"]).order_by(InventoryEvent.id.desc())).first()
        assert event.event_type == "COUNT_CONFIRMED" and event.delta == 0
