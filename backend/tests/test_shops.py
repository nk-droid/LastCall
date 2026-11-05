"""Shop onboarding: create, set up, submit, review, approve/reject/suspend; settings validation."""

from __future__ import annotations

from sqlalchemy import select

from app.db import transaction
from app.models import AuditEvent
from app.services import accounts, shops

from .conftest import new_client
from .factories import last_email, make_merchant, member_client, signup

PROFILE = {
    "name": "Juniper & Rye Bakehouse",
    "category": "Bakery",
    "tagline": "Neighborhood sourdough and pastry",
    "phone": "(555) 010-2468",
    "support_email": "hello@juniper-rye.com",
    "timezone": "America/Los_Angeles",
    "address": {"line1": "418 Alder Street", "city": "Fernhill", "region": "CA", "postal_code": "94000", "country": "US"},
}


def _owner_with_shop(app, profile: dict | None = None):
    c = new_client(app)
    signup(c, "owner@juniper-rye.com", "Morgan Lee")
    created = c.post("/api/shops", json=profile or PROFILE)
    assert created.status_code == 201, created.text
    return c, created.json()


def _admin(app):
    accounts.ensure_platform_admin(email="ops@lastcall.app", name="LastCall Ops", password="ops-password-123")
    c = new_client(app)
    assert c.post("/api/auth/login", json={"email": "ops@lastcall.app", "password": "ops-password-123"}).status_code == 200
    return c


def test_create_shop_makes_owner_and_draft(app):
    c, body = _owner_with_shop(app)
    assert body["shop"]["slug"] == "juniper-rye-bakehouse" and body["shop"]["status"] == "draft"
    assert body["account"]["memberships"][0]["role"] == "owner"
    assert body["account"]["active_shop_id"] == body["shop"]["id"]
    assert body["pickup"]["windows"]["mon"] == ["16:00", "19:00"]
    assert "The bakery reviews each request" in body["policies"]["cancellation_policy_text"]
    assert {i["key"]: i["done"] for i in body["checklist"]} == {"profile": True, "hours": True, "policies": False}
    other = new_client(app)
    signup(other, "second@juniper-rye.com")
    assert other.post("/api/shops", json=PROFILE).json()["shop"]["slug"] == "juniper-rye-bakehouse-2"


def test_create_shop_requires_sign_in_and_valid_timezone(app):
    assert new_client(app).post("/api/shops", json=PROFILE).status_code == 401
    c = new_client(app)
    signup(c, "someone@example.com")
    bad = c.post("/api/shops", json={**PROFILE, "timezone": "Mars/Olympus"})
    assert bad.status_code == 422 and bad.json()["error"]["details"][0]["field"] == "timezone"


def test_submit_requires_checklist_then_admin_approves(app):
    owner, body = _owner_with_shop(app)
    admin = _admin(app)
    early = owner.post("/api/merchant/shop/submit")
    assert early.status_code == 422 and early.json()["error"]["code"] == "setup_incomplete"
    owner.post("/api/merchant/shop/policies/confirm")
    submitted = owner.post("/api/merchant/shop/submit").json()
    assert submitted["shop"]["status"] == "pending_review"
    assert last_email("ops@lastcall.app", "shop_submitted").subject == "Review request: Juniper & Rye Bakehouse"
    queue = admin.get("/api/ops/shops", params={"status": "pending_review"}).json()
    assert [s["name"] for s in queue["shops"]] == ["Juniper & Rye Bakehouse"] and queue["shops"][0]["owners"] == ["owner@juniper-rye.com"]
    shop_id = body["shop"]["id"]
    partial = admin.post(f"/api/ops/shops/{shop_id}/approve", json={"checks": shops.APPROVAL_CHECKS[:1]})
    assert partial.status_code == 422
    approved = admin.post(f"/api/ops/shops/{shop_id}/approve", json={"checks": shops.APPROVAL_CHECKS}).json()
    assert approved["shop"]["status"] == "live" and approved["shop"]["verification"]["checks"] == shops.APPROVAL_CHECKS
    assert last_email("owner@juniper-rye.com", "shop_approved")
    assert admin.post(f"/api/ops/shops/{shop_id}/approve", json={"checks": shops.APPROVAL_CHECKS}).status_code == 409


def test_reject_resubmit_suspend_reinstate(app):
    owner, body = _owner_with_shop(app)
    admin = _admin(app)
    shop_id = body["shop"]["id"]
    owner.post("/api/merchant/shop/policies/confirm")
    owner.post("/api/merchant/shop/submit")
    rejected = admin.post(f"/api/ops/shops/{shop_id}/reject", json={"note": "Add the allergen sheet for the muffins"}).json()
    assert rejected["shop"]["status"] == "rejected"
    assert "allergen sheet" in last_email("owner@juniper-rye.com", "shop_rejected").text_body
    assert owner.get("/api/merchant/shop").json()["shop"]["review_note"] == "Add the allergen sheet for the muffins"
    assert owner.post("/api/merchant/shop/submit").json()["shop"]["status"] == "pending_review"
    admin.post(f"/api/ops/shops/{shop_id}/approve", json={"checks": shops.APPROVAL_CHECKS})
    assert admin.post(f"/api/ops/shops/{shop_id}/suspend", json={"note": "Payout account under review"}).json()["shop"]["status"] == "suspended"
    assert admin.post(f"/api/ops/shops/{shop_id}/reinstate").json()["shop"]["status"] == "live"
    with transaction() as db:
        actions = set(db.scalars(select(AuditEvent.action).where(AuditEvent.entity_id == shop_id)).all())
    assert {"shop_created", "policies_confirmed", "shop_submitted", "shop_rejected", "shop_approved", "shop_suspended", "shop_reinstated"} <= actions


def test_ops_endpoints_need_platform_admin(app):
    owner, body = _owner_with_shop(app)
    assert owner.get("/api/ops/shops").status_code == 403
    assert new_client(app).get("/api/ops/shops").status_code == 401


def test_only_owner_submits_and_confirms_policies(app):
    shop = make_merchant(status="draft", address={"line1": "1 Main", "city": "Town"}, phone="555", pickup_config=shops.default_pickup(),
                         policies=dict(shops.DEFAULT_POLICIES))
    manager, _ = member_client(app, shop, "manager")
    assert manager.post("/api/merchant/shop/policies/confirm").status_code == 403
    assert manager.post("/api/merchant/shop/submit").status_code == 403


def test_hours_and_pickup_windows_validate_per_day(app):
    owner, _ = _owner_with_shop(app)
    hours = {d: ["07:00", "19:00"] for d in shops.WEEKDAYS} | {"mon": None}
    windows = {d: ["16:00", "19:00"] for d in shops.WEEKDAYS} | {"mon": None, "sat": ["11:00", "14:00"]}
    saved = owner.put("/api/merchant/shop/hours", json={"hours": hours, "pickup": {"windows": windows, "slot_minutes": 15, "capacity": 4}}).json()
    assert saved["pickup"]["windows"]["mon"] is None and saved["pickup"]["windows"]["sat"] == ["11:00", "14:00"]
    backwards = owner.put("/api/merchant/shop/hours", json={"hours": hours, "pickup": {"windows": windows | {"tue": ["19:00", "16:00"]}}})
    assert backwards.status_code == 422 and backwards.json()["error"]["details"][0]["field"] == "pickup.windows.tue"
    garbage = owner.put("/api/merchant/shop/hours", json={"hours": hours | {"wed": ["7am", "7pm"]}, "pickup": {"windows": windows}})
    assert garbage.status_code == 422
    closed = owner.put("/api/merchant/shop/hours", json={"hours": hours, "pickup": {"windows": {d: None for d in shops.WEEKDAYS}}}).json()
    assert next(i for i in closed["checklist"] if i["key"] == "hours")["done"] is False


def test_policy_changes_bump_version_and_money_needs_owner(app):
    shop = make_merchant(policies=dict(shops.DEFAULT_POLICIES), policy_version=3)
    manager, _ = member_client(app, shop, "manager")
    owner, _ = member_client(app, shop, "owner")
    numbers = manager.patch("/api/merchant/shop/policies", json={"low_stock_threshold": 3}).json()
    assert numbers["policy_version"] == 3 and numbers["policies"]["low_stock_threshold"] == 3
    text = manager.patch("/api/merchant/shop/policies", json={"refund_policy_text": "Refunds within 24 hours."}).json()
    assert text["policy_version"] == 4
    assert manager.patch("/api/merchant/shop/policies", json={"fees_minor": 50}).status_code == 403
    assert owner.patch("/api/merchant/shop/policies", json={"tax_rates_bps": {"bakery": 875}}).json()["policies"]["tax_rates_bps"] == {"bakery": 875}
    assert owner.patch("/api/merchant/shop/policies", json={"tax_rates_bps": {"bakery": 9000}}).status_code == 422
    assert manager.patch("/api/merchant/shop/policies", json={"reservation_ttl_seconds": 5}).status_code == 422
    assert manager.patch("/api/merchant/shop/policies", json={"pickup_instructions": "   "}).status_code == 422


def test_live_shop_timezone_is_locked(app):
    shop = make_merchant(address={"line1": "1 Main", "city": "Town"})
    owner, _ = member_client(app, shop, "owner")
    changed = owner.put("/api/merchant/shop/profile", json={**PROFILE, "timezone": "America/New_York"})
    assert changed.status_code == 422
    renamed = owner.put("/api/merchant/shop/profile", json={**PROFILE, "name": "Juniper & Rye"}).json()
    assert renamed["shop"]["name"] == "Juniper & Rye" and renamed["shop"]["slug"] == "juniper-rye"


def test_staff_can_view_but_not_edit_settings(app):
    shop = make_merchant()
    staff, _ = member_client(app, shop, "staff")
    view = staff.get("/api/merchant/shop").json()
    assert view["can_edit"] is False and view["can_edit_money"] is False
    assert staff.put("/api/merchant/shop/pickup-paused", json={"paused": True}).status_code == 403
