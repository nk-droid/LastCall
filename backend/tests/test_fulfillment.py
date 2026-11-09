"""Fulfillment acceptance tests (AT-10) plus the pickup queue, cancellations, support replies and shop isolation."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select

from app import clock
from app.db import transaction
from app.models import InventoryLot, Merchant, Product, SystemState
from app.security import pickup_code, pickup_code_hash, verify_pickup_code

from .factories import member_client
from .fixtures import seed_bakery
from .helpers import available, buy, ok, product_id, quote_lines, shop_id, start_checkout

pytestmark = pytest.mark.usefixtures("bakery")


def _member(app, role: str = "staff", slug: str = "juniper-rye"):
    return member_client(app, shop_id(slug), role)[0]


def _wrong(code: str) -> str:
    return "0000" if code != "0000" else "1111"


def test_pickup_codes_are_hashed_and_verified_in_constant_time():
    code = pickup_code("ord_1", "salt")
    assert len(code) == 4 and code.isdigit()
    stored = pickup_code_hash("ord_1", code)
    assert code not in stored
    assert verify_pickup_code("ord_1", code, stored)
    assert verify_pickup_code("ord_1", f" {code[:2]}-{code[2:]} ", stored)
    assert not verify_pickup_code("ord_1", _wrong(code), stored)


def test_at10_pickup_code_completes_handoff_and_wrong_code_is_rejected(client, app):
    before = available("CR-01")
    co, view = buy(client, [("CR-01", 2)])
    code = view["pickup"]["code"]
    assert code and len(code) == 4
    staff = _member(app)
    ok(staff.post(f"/api/merchant/orders/{co['order_id']}/fulfillment", json={"action": "start_packing"}))
    ok(staff.post(f"/api/merchant/orders/{co['order_id']}/fulfillment", json={"action": "mark_ready"}))
    r = staff.post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": _wrong(code)})
    assert r.status_code == 422 and r.json()["error"]["code"] == "wrong_pickup_code"
    detail = ok(staff.post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": code}))
    assert detail["fulfillment_status"] == "PICKED_UP" and detail["payment_status"] == "CAPTURED"
    assert available("CR-01") == before - 2
    with transaction() as db:
        assert db.scalar(select(InventoryLot.surplus_qty).where(InventoryLot.product_id == product_id("CR-01"))) == 8 - 2
    view = ok(client.get(f"/api/orders/{co['order_id']}"))
    assert view["status"]["key"] == "picked_up" and view["pickup"]["code"] is None
    assert staff.post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": code}).status_code == 409


def test_at10_repeated_wrong_codes_lock_staff_out(client, app):
    co, view = buy(client, [("BR-02", 1)])
    staff = _member(app)
    ok(staff.post(f"/api/merchant/orders/{co['order_id']}/fulfillment", json={"action": "mark_ready"}))
    for _ in range(5):
        assert staff.post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": _wrong(view["pickup"]["code"])}).status_code == 422
    locked = staff.post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": view["pickup"]["code"]})
    assert locked.status_code == 409 and locked.json()["error"]["code"] == "pickup_locked"
    manager = _member(app, "manager")
    assert ok(manager.post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": view["pickup"]["code"]}))["fulfillment_status"] == "PICKED_UP"


def _number(app, order_id: str) -> str:
    return ok(_member(app).get(f"/api/merchant/orders/{order_id}"))["number"]


def test_counter_lookup_finds_the_order_from_a_scan_a_typed_code_or_number_and_code(client, app):
    co, view = buy(client, [("CR-01", 2)])
    code, number = view["pickup"]["code"], _number(app, co["order_id"])
    staff = _member(app)
    for typed in (f"LASTCALL:{number}:{code}", code, f"{code[:2]} {code[2:]}", f"{number.removeprefix('LC-')} {code}", f"#{number} · {code}"):
        found = ok(staff.post("/api/merchant/pickups/lookup", json={"code": typed}))
        assert found["code"] == code and [m["id"] for m in found["matches"]] == [co["order_id"]], typed
    match = found["matches"][0]
    assert match["fulfillment_status"] == "NEW" and match["lines"][0]["qty"] == 2 and match["pickup_locked"] is False
    # Looking up hands nothing off.
    assert ok(staff.get(f"/api/merchant/orders/{co['order_id']}"))["fulfillment_status"] == "NEW"
    bad = staff.post("/api/merchant/pickups/lookup", json={"code": "hello there"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "bad_pickup_code"


def test_counter_lookup_locks_after_five_misses_until_a_manager_unlocks(client, app):
    co, view = buy(client, [("BR-02", 1)])
    code, staff = view["pickup"]["code"], _member(app)
    for left in (4, 3, 2, 1):
        miss = staff.post("/api/merchant/pickups/lookup", json={"code": _wrong(code)})
        assert miss.status_code == 422 and miss.json()["error"]["code"] == "no_pickup_match"
        assert miss.json()["error"]["details"]["remaining"] == left
    locked = staff.post("/api/merchant/pickups/lookup", json={"code": _wrong(code)})
    assert locked.status_code == 409 and locked.json()["error"]["code"] == "lookup_locked"
    # Locked for everyone, even with the right code; misses don't touch the order's own attempt count.
    assert staff.post("/api/merchant/pickups/lookup", json={"code": code}).json()["error"]["code"] == "lookup_locked"
    assert ok(staff.get(f"/api/merchant/orders/{co['order_id']}"))["pickup_attempts"] == 0
    assert staff.post("/api/merchant/pickups/lookup/unlock").status_code == 403
    ok(_member(app, "manager").post("/api/merchant/pickups/lookup/unlock"))
    assert ok(staff.post("/api/merchant/pickups/lookup", json={"code": code}))["matches"][0]["id"] == co["order_id"]


def test_counter_lookup_lock_expires_and_a_double_scan_is_not_a_miss(client, app):
    co, view = buy(client, [("BR-02", 1)])
    code, staff = view["pickup"]["code"], _member(app)
    for _ in range(5):
        staff.post("/api/merchant/pickups/lookup", json={"code": _wrong(code)})
    clock.advance(timedelta(minutes=11))
    assert ok(staff.post("/api/merchant/pickups/lookup", json={"code": code}))["matches"]
    ok(staff.post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": code, "mark_ready": True}))
    again = staff.post("/api/merchant/pickups/lookup", json={"code": code})
    assert again.status_code == 409 and again.json()["error"]["code"] == "already_picked_up"
    with transaction() as db:
        state = db.get(SystemState, f"pickup_lookup:{shop_id()}")
        assert state.value["misses"] == [] and state.value["locked_until"] is None


def test_handoff_can_mark_ready_at_the_counter_but_only_with_the_right_code(client, app):
    co, view = buy(client, [("CR-01", 1)])
    code, staff = view["pickup"]["code"], _member(app)
    not_ready = staff.post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": code})
    assert not_ready.status_code == 409 and not_ready.json()["error"]["code"] == "not_ready"
    wrong = staff.post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": _wrong(code), "mark_ready": True})
    assert wrong.status_code == 422
    assert ok(staff.get(f"/api/merchant/orders/{co['order_id']}"))["fulfillment_status"] == "NEW"
    done = ok(staff.post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": code, "mark_ready": True}))
    assert done["fulfillment_status"] == "PICKED_UP"
    assert any(e["action"] == "fulfillment_ready" and e["meta"].get("at_handoff") for e in done["timeline"])


def test_at10_unpaid_order_cannot_be_handed_off(client, app):
    co = start_checkout(client, quote_lines(client, [("CR-01", 1)])["id"])
    r = _member(app).post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": "1234"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_paid"
    packing = _member(app).post(f"/api/merchant/orders/{co['order_id']}/fulfillment", json={"action": "start_packing"})
    assert packing.status_code == 409 and packing.json()["error"]["code"] == "not_paid"


def test_queue_groups_orders_and_detail_shows_payment_evidence(client, app):
    paid, _ = buy(client, [("CR-01", 1)])
    pending = start_checkout(client, quote_lines(client, [("BR-02", 1)])["id"])
    staff = _member(app)
    queue = ok(staff.get("/api/merchant/orders"))
    assert [o["id"] for o in queue["groups"]["awaiting_pickup"]] == [paid["order_id"]]
    assert [o["id"] for o in queue["groups"]["payment_pending"]] == [pending["order_id"]]
    detail = ok(staff.get(f"/api/merchant/orders/{paid['order_id']}"))
    payment = detail["payments"][0]
    assert payment["state"] == "CAPTURED" and payment["capture_id"] and payment["paypal_order_id"] == paid["paypal_order_id"]
    assert detail["refundable_minor"] == 250 and any(e["action"] == "capture_verified" for e in detail["timeline"])


def test_queue_hides_finished_orders_from_previous_days(client, app):
    co, view = buy(client, [("BR-02", 1)])
    manager = _member(app, "manager")
    ok(manager.post(f"/api/merchant/orders/{co['order_id']}/fulfillment", json={"action": "mark_ready"}))
    ok(manager.post(f"/api/merchant/orders/{co['order_id']}/handoff", json={"pickup_code": view["pickup"]["code"]}))
    assert ok(manager.get("/api/merchant/orders"))["groups"]["complete"]
    clock.advance(timedelta(days=1))
    assert ok(manager.get("/api/merchant/orders"))["groups"]["complete"] == []


def test_manager_declines_cancellation_and_staff_cannot_refund(client, app):
    co, _ = buy(client, [("CR-01", 1)], slot_index=2)
    ok(client.post(f"/api/orders/{co['order_id']}/cancel-request", json={"reason": "Running late"}))
    staff = _member(app)
    assert staff.post(f"/api/merchant/orders/{co['order_id']}/cancel-request/decline", json={"reason": "Already packed"}).status_code == 403
    manager = _member(app, "manager")
    assert ok(manager.get(f"/api/merchant/orders/{co['order_id']}"))["cancel_requested"] is True
    detail = ok(manager.post(f"/api/merchant/orders/{co['order_id']}/cancel-request/decline", json={"reason": "Already packed"}))
    assert detail["cancel_request"]["status"] == "declined" and detail["cancel_requested"] is False
    assert ok(client.get(f"/api/orders/{co['order_id']}"))["cancellation"]["request"]["status"] == "declined"


def test_support_message_creates_staff_draft_without_authority(client, app):
    co, _ = buy(client, [("CR-01", 1)])
    view = ok(client.post(f"/api/orders/{co['order_id']}/support", json={"message": "Can I get a refund? My email is maya@example.com"}))
    assert view["support"][0]["status"] == "open"
    staff = _member(app)
    detail = ok(staff.get(f"/api/merchant/orders/{co['order_id']}"))
    draft = detail["support"][0]
    assert draft["ai_draft"] and detail["refund_status"] == "NONE" and detail["payment_status"] == "CAPTURED"
    replied = ok(staff.post(f"/api/merchant/support/{draft['id']}/reply", json={"reply": "Happy to help, see you at 4!"}))
    assert replied["support"][0]["status"] == "replied" and replied["support"][0]["replied_by"] == "Staff Person"


def test_staff_only_see_and_change_their_own_shop(client, app):
    co, _ = buy(client, [("CR-01", 1)])
    other_shop = seed_bakery(slug="copper-kettle", name="Copper Kettle Café")
    other = member_client(app, other_shop, "owner")[0]
    queue = ok(other.get("/api/merchant/orders"))
    assert all(o["id"] != co["order_id"] for group in queue["groups"].values() for o in group)
    assert other.get(f"/api/merchant/orders/{co['order_id']}").status_code == 404
    assert other.post(f"/api/merchant/orders/{co['order_id']}/fulfillment", json={"action": "start_packing"}).status_code == 404
    assert other.post(f"/api/merchant/orders/{co['order_id']}/refund", json={"reason": "Not ours"}).status_code == 404
    juniper_product = product_id("CR-01")
    assert other.post("/api/merchant/inventory", json={"product_id": juniper_product, "action": "set", "value": 0}).status_code == 404
    with transaction() as db:
        assert db.scalar(select(Merchant.slug).where(Merchant.id == other_shop)) == "copper-kettle"
        assert db.scalar(select(Product.id).where(Product.id == juniper_product)) is not None
