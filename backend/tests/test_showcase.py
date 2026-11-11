"""Showcase seed and daily listing templates."""

from __future__ import annotations

import json
from datetime import timedelta

import pytest
from PIL import Image
from sqlalchemy import func, select

from app import clock
from app.db import transaction
from app.models import InventoryEvent, Membership, Merchant, Product
from app.seed import showcase
from app.services import listings

from .conftest import new_client
from .factories import member_client
from .helpers import available, buy, ok, shop_id

BUNDLED = showcase.PHOTOS


@pytest.fixture(autouse=True)
def tiny_photos(tmp_path_factory, monkeypatch):
    """Seed with tiny stand-ins for the bundled photos (shoppers only see products with a photo)."""
    folder = tmp_path_factory.getbasetemp() / "showcase-photos"
    if not folder.exists():
        for spec in showcase.SHOWCASE:
            (folder / spec["slug"]).mkdir(parents=True)
            for i, item in enumerate(spec["catalog"]):
                Image.new("RGB", (8, 6), (i * 20 % 255, 120, 80)).save(folder / spec["slug"] / f"{item['sku']}.png")
    monkeypatch.setattr(showcase, "PHOTOS", folder)

def test_seed_creates_live_shops_once_with_staff_and_payees(app, monkeypatch):
    monkeypatch.setenv("SHOWCASE_PAYEE_JUNIPER_RYE", "JUNIPERRYE001")
    first = showcase.seed(password="showcase-password-1")
    assert first["created"] == ["juniper-rye", "copper-kettle", "golden-bun", "night-owl"]
    second = showcase.seed(password="showcase-password-1")
    assert second["created"] == [] and len(second["existing"]) == 4
    with transaction() as db:
        merchants = {m.slug: m for m in db.scalars(select(Merchant)).all()}
        assert all(m.status == "live" and m.is_showcase for m in merchants.values())
        assert merchants["juniper-rye"].paypal["merchant_id"] == "JUNIPERRYE001" and merchants["copper-kettle"].paypal == {}
        assert db.scalar(select(func.count()).select_from(Membership)) == 12
        assert db.scalar(select(func.count()).select_from(Product).where(Product.relist_daily.is_(True))) > 30
    c = new_client(app)
    me = ok(c.post("/api/auth/login", json={"email": showcase.staff_email("night-owl", "owner"), "password": "showcase-password-1"}))
    assert me["memberships"][0]["shop"]["slug"] == "night-owl" and me["memberships"][0]["role"] == "owner"
    assert {m["slug"] for m in ok(c.get("/api/merchants"))["merchants"]} == {"juniper-rye", "copper-kettle", "golden-bun", "night-owl"}


def test_seed_without_password_creates_no_accounts():
    showcase.seed()
    with transaction() as db:
        assert db.scalar(select(func.count()).select_from(Membership)) == 0


def test_twenty_four_hour_shop_always_has_a_pickup_slot(client):
    showcase.seed()
    for hours in (0, 6, 12, 20):
        clock.advance(timedelta(hours=hours))
        slots = [s for s in ok(client.get("/api/merchants/night-owl/pickup-slots"))["slots"] if s["bookable"]]
        assert slots, f"no bookable slot {hours}h later"


def test_daily_listing_relists_once_per_day_and_keeps_promised_units(client, app):
    showcase.seed()
    buy(client, [("CR-01", 2)])  # committed: paid, not yet picked up
    staff = member_client(app, shop_id(), "manager")[0]
    ok(staff.post("/api/merchant/inventory", json={"product_id": next(r["product_id"] for r in ok(staff.get("/api/merchant/inventory"))["rows"]
                                                                       if r["sku"] == "BR-02"), "action": "counter_sale", "delta": 10}))
    assert available("BR-02") == 0
    clock.advance(timedelta(hours=16))  # 7 AM the next day, after Juniper & Rye's 6:00 listing time
    with transaction() as db:
        merchant = db.get(Merchant, shop_id())
        assert listings.due(db, merchant, clock.now())
        listings.relist(db, merchant, clock.now())
        assert not listings.due(db, merchant, clock.now())
    assert available("BR-02") == 10
    assert available("CR-01") == 8  # the 2 owed to yesterday's paid order stay on top of the template quantity
    with transaction() as db:
        assert db.scalar(select(func.count()).select_from(InventoryEvent).where(InventoryEvent.event_type == "RELISTED")) >= 12


def test_relist_waits_for_the_shops_listing_time():
    showcase.seed()
    clock.advance(timedelta(hours=12))  # 3 AM next day; Juniper & Rye lists at 6:00
    with transaction() as db:
        assert not listings.due(db, db.get(Merchant, shop_id()), clock.now())
        assert listings.due(db, db.get(Merchant, shop_id("night-owl")), clock.now())  # lists at 00:05


def test_manager_publishes_listing_from_the_console(app):
    showcase.seed()
    manager = member_client(app, shop_id(), "manager")[0]
    staff = member_client(app, shop_id(), "staff")[0]
    assert staff.post("/api/merchant/listings/publish").status_code == 403
    assert ok(manager.post("/api/merchant/listings/publish"))["relisted"] == 12
    row = next(r for r in ok(manager.get("/api/merchant/inventory"))["rows"] if r["sku"] == "CR-01")
    assert row["relist"] == {"enabled": True, "qty": 8, "cutoff_local": "18:30"}


def test_bundled_photos_cover_every_showcase_product_with_a_credit():
    credits = json.loads((BUNDLED / "credits.json").read_text())
    for spec in showcase.SHOWCASE:
        for item in spec["catalog"]:
            key = f"{spec['slug']}/{item['sku']}"
            assert any((BUNDLED / f"{key}.{ext}").exists() for ext in ("jpg", "png", "webp")), f"no photo for {key}"
            assert credits[key]["license"] and credits[key]["author"] and credits[key]["url"].startswith("https://"), key


def test_seeded_photos_are_attached_once_and_credited(client, tmp_path):
    for sku in ("CR-01", "BR-02"):
        (tmp_path / "juniper-rye").mkdir(exist_ok=True)
        Image.new("RGB", (40, 30), "tan" if sku == "CR-01" else "brown").save(tmp_path / "juniper-rye" / f"{sku}.png")
    credit = {"source": "Wikimedia Commons", "title": "Croissant.jpg", "author": "A. Baker", "url": "https://commons.wikimedia.org/wiki/File:Croissant.jpg",
              "license": "CC BY 2.0", "license_url": "https://creativecommons.org/licenses/by/2.0"}
    (tmp_path / "credits.json").write_text(json.dumps({"juniper-rye/CR-01": credit}))

    assert showcase.seed(photos=tmp_path)["photos"] == 2
    assert showcase.seed(photos=tmp_path)["photos"] == 0  # products that already have a photo keep it

    photos = ok(client.get("/api/credits"))["photos"]
    assert len(photos) == 1  # BR-02's photo has no licence to credit
    assert photos[0]["product"] == "Butter croissant" and photos[0]["shop"]["slug"] == "juniper-rye"
    assert {k: photos[0][k] for k in credit} == credit
    assert client.get(photos[0]["image_url"]).status_code == 200
