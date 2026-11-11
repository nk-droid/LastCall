"""Photo uploads: validation, normalization (WebP, resized, metadata stripped) and cached delivery."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app.db import transaction
from app.models import BundleQuote, Order, Product

from .factories import member_client
from .helpers import bookable_slot, buy, ok, product_id, shop_id
from .test_catalog import NEW_PRODUCT
from .test_checkout import _product_input

pytestmark = pytest.mark.usefixtures("bakery")


def _jpeg(width: int = 2400, height: int = 1600, exif: bool = True) -> bytes:
    image = Image.new("RGB", (width, height), (214, 160, 80))
    out = io.BytesIO()
    if exif:
        info = Image.Exif()
        info[0x010F] = "PhoneMaker"  # camera make
        info[0x0132] = "2026:11:03 10:00:00"  # capture time
        image.save(out, format="JPEG", exif=info.tobytes())
    else:
        image.save(out, format="JPEG")
    return out.getvalue()


def _upload(member, data: bytes, name: str = "croissant.jpg", mime: str = "image/jpeg"):
    return member.post("/api/merchant/assets", files={"file": (name, data, mime)})


def test_upload_is_resized_reencoded_and_stripped(app):
    manager = member_client(app, shop_id(), "manager")[0]
    body = ok(_upload(manager, _jpeg()), 201)
    assert (body["width"], body["height"]) == (1600, 1067) and body["url"] == f"/api/assets/{body['id']}"
    full = manager.get(body["url"])
    assert full.headers["content-type"] == "image/webp" and "immutable" in full.headers["cache-control"]
    stored = Image.open(io.BytesIO(full.content))
    assert stored.format == "WEBP" and not stored.getexif()
    thumb = Image.open(io.BytesIO(manager.get(body["url"], params={"size": "thumb"}).content))
    assert max(thumb.size) == 480
    assert manager.get(body["url"], headers={"If-None-Match": full.headers["etag"]}).status_code == 304
    assert ok(_upload(manager, _jpeg()), 201)["id"] == body["id"]  # same photo, same asset


def test_non_images_and_oversized_files_are_rejected(app):
    manager = member_client(app, shop_id(), "manager")[0]
    fake = _upload(manager, b"<?php echo 'hi'; ?>", name="photo.jpg")
    assert fake.status_code == 422 and fake.json()["error"]["code"] == "image_invalid"
    gif = io.BytesIO()
    Image.new("RGB", (10, 10)).save(gif, format="GIF")
    assert _upload(manager, gif.getvalue(), name="a.gif", mime="image/gif").json()["error"]["code"] == "image_type"
    huge = _upload(manager, b"\xff\xd8\xff" + b"0" * (8 * 1024 * 1024 + 10))
    assert huge.status_code == 422 and huge.json()["error"]["code"] == "image_too_large"
    staff = member_client(app, shop_id(), "staff")[0]
    assert _upload(staff, _jpeg(exif=False)).status_code == 403


def test_product_photo_must_be_an_uploaded_asset(app, client):
    manager = member_client(app, shop_id(), "manager")[0]
    photo = ok(_upload(manager, _jpeg(exif=False)), 201)
    pid, body = _product_input(manager, "CR-01", image_url="https://example.com/stock.jpg")
    assert manager.put(f"/api/merchant/products/{pid}", json=body).status_code == 422
    body["image_url"] = photo["url"]
    assert ok(manager.put(f"/api/merchant/products/{pid}", json=body))["row"]["image"]["url"] == photo["url"]
    item = next(i for i in ok(client.get("/api/merchants/juniper-rye/catalog"))["items"] if i["sku"] == "CR-01")
    assert item["image"] == {"url": photo["url"], "alt": "Photo of Butter croissant"}
    assert pid == product_id("CR-01")


def test_new_product_needs_a_photo_its_shop_uploaded(app, client):
    manager = member_client(app, shop_id(), "manager")[0]
    photo = ok(_upload(manager, _jpeg(exif=False)), 201)
    assert manager.post("/api/merchant/products", json=NEW_PRODUCT).status_code == 422
    for fake in ("https://example.com/stock.jpg", "/api/assets/img_not_uploaded"):
        assert manager.post("/api/merchant/products", json={**NEW_PRODUCT, "image_url": fake}).status_code == 422
    row = ok(manager.post("/api/merchant/products", json={**NEW_PRODUCT, "image_url": photo["url"]}), 201)["row"]
    assert row["image"]["url"] == photo["url"]
    item = next(i for i in ok(client.get("/api/merchants/juniper-rye/catalog"))["items"] if i["sku"] == NEW_PRODUCT["sku"])
    assert item["image"] == {"url": photo["url"], "alt": f"Photo of {NEW_PRODUCT['name']}"}


def test_product_without_a_photo_is_hidden_from_shoppers_until_it_has_one(app, client):
    manager = member_client(app, shop_id(), "manager")[0]
    pid, body = _product_input(manager, "CR-01")
    with transaction() as db:
        db.get(Product, pid).image_url = None  # a product listed before photos were required
    assert "CR-01" not in {i["sku"] for i in ok(client.get("/api/merchants/juniper-rye/catalog"))["items"]}
    quote = client.post("/api/quotes", json={"merchant": "juniper-rye", "lines": [{"sku": "CR-01", "qty": 1}], "pickup_slot_id": bookable_slot(client)})
    assert quote.status_code == 409 and quote.json()["error"]["details"]["problems"][0]["sku"] == "CR-01"
    row = next(r for r in ok(manager.get("/api/merchant/inventory"))["rows"] if r["sku"] == "CR-01")
    assert row["image"]["url"] is None  # the shop still sees it, to add a photo
    photo = ok(_upload(manager, _jpeg(exif=False)), 201)
    ok(manager.put(f"/api/merchant/products/{pid}", json={**body, "image_url": photo["url"]}))
    ok(manager.put(f"/api/merchant/products/{pid}", json=body))  # an edit without a photo keeps the current one
    item = next(i for i in ok(client.get("/api/merchants/juniper-rye/catalog"))["items"] if i["sku"] == "CR-01")
    assert item["image"]["url"] == photo["url"]


def test_order_sold_before_its_photo_shows_it_but_keeps_its_prices(app, client):
    co, _ = buy(client, [("CR-01", 2)])
    with transaction() as db:  # an order placed before the product had a photo
        quote = db.get(BundleQuote, db.get(Order, co["order_id"]).quote_id)
        quote.item_lines = [{**line, "image": {"url": None, "alt": "Butter croissant (no photo yet)"}} for line in quote.item_lines]
    line = ok(client.get(f"/api/orders/{co['order_id']}"))["lines"][0]
    manager = member_client(app, shop_id(), "manager")[0]
    photo = ok(_upload(manager, _jpeg(exif=False)), 201)
    pid, body = _product_input(manager, "CR-01", image_url=photo["url"])
    ok(manager.put(f"/api/merchant/products/{pid}", json=body))
    ok(manager.post(f"/api/merchant/products/{pid}/price", json={"reference_minor": 900, "sale_minor": 500, "reference_source": "Menu board"}))
    after = ok(client.get(f"/api/orders/{co['order_id']}"))["lines"][0]
    assert after["image"] == {"url": photo["url"], "alt": "Photo of Butter croissant"}
    assert {k: after[k] for k in after if k != "image"} == {k: line[k] for k in line if k != "image"}  # still as sold
