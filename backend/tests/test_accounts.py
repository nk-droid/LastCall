"""Accounts, sessions, passwords, invites and shop roles."""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app import clock
from app.db import transaction
from app.models import AuditEvent, User
from app.services import accounts

from .conftest import ORIGIN, new_client
from .factories import PASSWORD, add_member, last_email, make_merchant, member_client, signup, token_from


def _client(app) -> TestClient:
    return new_client(app)


def test_signup_signs_in_and_me_reflects_the_account(client):
    view = signup(client, "maya@example.com", "Maya Rivera")
    assert view["user"]["email"] == "maya@example.com" and view["user"]["initials"] == "MR"
    assert client.cookies.get("lc_auth")
    me = client.get("/api/auth/me").json()
    assert me["user"]["name"] == "Maya Rivera" and me["memberships"] == []


def test_signup_rejects_duplicates_and_weak_passwords(client, app):
    signup(client, "maya@example.com")
    other = _client(app)
    dup = other.post("/api/auth/signup", json={"name": "Maya", "email": "MAYA@example.com", "password": PASSWORD})
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "email_taken"
    weak = other.post("/api/auth/signup", json={"name": "Sam", "email": "sam@example.com", "password": "short"})
    assert weak.status_code == 422
    assert weak.json()["error"]["details"][0]["field"] == "password"


def test_login_logout_and_wrong_password(app):
    c = _client(app)
    signup(c, "sam@example.com")
    c.post("/api/auth/logout")
    assert c.get("/api/auth/me").json()["user"] is None
    bad = c.post("/api/auth/login", json={"email": "sam@example.com", "password": "not-the-password"})
    assert bad.status_code == 401 and bad.json()["error"]["code"] == "invalid_credentials"
    unknown = c.post("/api/auth/login", json={"email": "nobody@example.com", "password": "whatever-it-is"})
    assert unknown.status_code == 401 and unknown.json()["error"]["message"] == bad.json()["error"]["message"]
    ok = c.post("/api/auth/login", json={"email": "Sam@Example.com", "password": PASSWORD})
    assert ok.status_code == 200 and c.get("/api/auth/me").json()["user"]["email"] == "sam@example.com"


def test_repeated_failures_lock_the_account(app):
    c = _client(app)
    signup(c, "ana@example.com")
    for _ in range(accounts.MAX_FAILED_LOGINS):
        assert c.post("/api/auth/login", json={"email": "ana@example.com", "password": "wrong-password"}).status_code == 401
    locked = c.post("/api/auth/login", json={"email": "ana@example.com", "password": PASSWORD})
    assert locked.status_code == 401 and locked.json()["error"]["code"] == "account_locked"
    clock.advance(accounts.LOCKOUT + timedelta(seconds=1))
    assert c.post("/api/auth/login", json={"email": "ana@example.com", "password": PASSWORD}).status_code == 200
    with transaction() as db:
        assert db.scalar(select(AuditEvent).where(AuditEvent.action == "account_locked"))


def test_sessions_expire_and_slide(app):
    c = _client(app)
    signup(c, "leo@example.com")
    clock.advance(accounts.SESSION_TTL - timedelta(hours=2))
    assert c.get("/api/auth/me").json()["user"] is not None  # refreshes the expiry
    clock.advance(timedelta(hours=3))
    assert c.get("/api/auth/me").json()["user"] is not None
    clock.advance(accounts.SESSION_TTL + timedelta(seconds=1))
    assert c.get("/api/auth/me").json()["user"] is None


def test_password_reset_flow_is_single_use_and_revokes_sessions(app):
    first = _client(app)
    signup(first, "maya@example.com", "Maya Rivera")
    anon = _client(app)
    assert anon.post("/api/auth/password/forgot", json={"email": "maya@example.com"}).status_code == 202
    assert anon.post("/api/auth/password/forgot", json={"email": "ghost@example.com"}).status_code == 202  # same answer
    message = last_email("maya@example.com", "password_reset")
    assert message.subject == "Reset your LastCall password" and "reset_link" not in message.context
    token = token_from(message, "/reset-password")
    new_password = "a-brand-new-secret"
    reset = anon.post("/api/auth/password/reset", json={"token": token, "password": new_password})
    assert reset.status_code == 200 and anon.get("/api/auth/me").json()["user"]["email"] == "maya@example.com"
    assert first.get("/api/auth/me").json()["user"] is None  # older sessions were revoked
    again = anon.post("/api/auth/password/reset", json={"token": token, "password": "yet-another-secret"})
    assert again.status_code == 422 and again.json()["error"]["code"] == "reset_link_invalid"
    assert _client(app).post("/api/auth/login", json={"email": "maya@example.com", "password": new_password}).status_code == 200


def test_change_password_keeps_current_session_only(app):
    a = _client(app)
    signup(a, "sam@example.com")
    b = _client(app)
    b.post("/api/auth/login", json={"email": "sam@example.com", "password": PASSWORD})
    wrong = a.post("/api/auth/password/change", json={"current_password": "nope-nope-nope", "new_password": "fresh-password-42"})
    assert wrong.status_code == 422
    assert a.post("/api/auth/password/change", json={"current_password": PASSWORD, "new_password": "fresh-password-42"}).status_code == 200
    assert a.get("/api/auth/me").json()["user"] is not None
    assert b.get("/api/auth/me").json()["user"] is None


def test_staff_context_requires_membership_and_role(app):
    shop = make_merchant()
    outsider = _client(app)
    signup(outsider, "outsider@example.com")
    assert outsider.get("/api/merchant/team").json()["error"]["code"] == "no_shop"
    staff, _ = member_client(app, shop, "staff")
    assert staff.get("/api/merchant/team").status_code == 403
    manager, _ = member_client(app, shop, "manager")
    assert manager.get("/api/merchant/team").status_code == 200
    assert _client(app).get("/api/merchant/team").status_code == 401


def test_invite_new_person_creates_account_and_membership(app):
    shop = make_merchant()
    manager, _ = member_client(app, shop, "manager", email="manager@example.com")
    assert manager.post("/api/merchant/team/invites", json={"email": "new@example.com", "role": "manager"}).status_code == 403
    created = manager.post("/api/merchant/team/invites", json={"email": "New@Example.com", "role": "staff"})
    assert created.status_code == 201 and "/invite/" in created.json()["link"]
    message = last_email("new@example.com", "staff_invite")
    assert "Juniper & Rye Bakehouse" in message.subject
    token = token_from(message, "/invite")
    guest = _client(app)
    preview = guest.get(f"/api/invites/{token}").json()
    assert preview["shop"]["name"] == "Juniper & Rye Bakehouse" and preview["has_account"] is False and preview["role"] == "staff"
    missing = guest.post(f"/api/invites/{token}/accept", json={})
    assert missing.status_code == 422
    accepted = guest.post(f"/api/invites/{token}/accept", json={"name": "Jordan Kim", "password": PASSWORD}).json()
    assert accepted["memberships"][0]["role"] == "staff" and accepted["active_shop_id"] == shop
    assert guest.get(f"/api/invites/{token}").status_code == 404  # single use
    team = manager.get("/api/merchant/team").json()
    assert {m["email"] for m in team["members"]} == {"manager@example.com", "new@example.com"} and team["invites"] == []


def test_invite_for_existing_account_needs_that_account_signed_in(app):
    shop = make_merchant()
    owner, _ = member_client(app, shop, "owner")
    existing = _client(app)
    signup(existing, "barista@example.com", "Riley Barista")
    link = owner.post("/api/merchant/team/invites", json={"email": "barista@example.com", "role": "manager"}).json()["link"]
    token = link.rsplit("/", 1)[1]
    stranger = _client(app)
    signup(stranger, "someone-else@example.com")
    assert stranger.post(f"/api/invites/{token}/accept", json={}).json()["error"]["code"] == "sign_in_required"
    view = existing.post(f"/api/invites/{token}/accept", json={}).json()
    assert view["memberships"][0]["role"] == "manager"
    assert existing.get("/api/merchant/team").status_code == 200


def test_owner_role_changes_and_last_owner_protection(app):
    shop = make_merchant()
    owner, owner_view = member_client(app, shop, "owner")
    staff, staff_view = member_client(app, shop, "staff")
    members = owner.get("/api/merchant/team").json()["members"]
    owner_member = next(m for m in members if m["user_id"] == owner_view["user"]["id"])
    staff_member = next(m for m in members if m["user_id"] == staff_view["user"]["id"])
    last = owner.patch(f"/api/merchant/team/members/{owner_member['membership_id']}", json={"role": "manager"})
    assert last.status_code == 409 and last.json()["error"]["code"] == "last_owner"
    promoted = owner.patch(f"/api/merchant/team/members/{staff_member['membership_id']}", json={"role": "manager"}).json()
    assert next(m for m in promoted["members"] if m["user_id"] == staff_view["user"]["id"])["role"] == "manager"
    assert staff.get("/api/merchant/team").status_code == 200  # the new role applies immediately
    owner.delete(f"/api/merchant/team/members/{staff_member['membership_id']}")
    assert staff.get("/api/merchant/team").json()["error"]["code"] == "no_shop"


def test_owner_can_issue_reset_link_for_teammate(app):
    shop = make_merchant()
    owner, _ = member_client(app, shop, "owner")
    staff, staff_view = member_client(app, shop, "staff", email="counter@example.com")
    member = next(m for m in owner.get("/api/merchant/team").json()["members"] if m["user_id"] == staff_view["user"]["id"])
    link = owner.post(f"/api/merchant/team/members/{member['membership_id']}/reset-link").json()["link"]
    assert staff.post(f"/api/merchant/team/members/{member['membership_id']}/reset-link").status_code == 403
    token = link.rsplit("/", 1)[1]
    assert _client(app).post("/api/auth/password/reset", json={"token": token, "password": "counter-new-secret"}).status_code == 200


def test_active_shop_switches_between_memberships(app):
    first, second = make_merchant(), make_merchant(slug="copper-kettle", name="Copper Kettle Café")
    c, view = member_client(app, first, "manager")
    add_member(view["user"]["id"], second, "owner")
    me = c.get("/api/auth/me").json()
    assert len(me["memberships"]) == 2
    switched = c.post("/api/auth/active-shop", json={"shop_id": second}).json()
    assert switched["active_shop_id"] == second
    assert c.patch("/api/merchant/team/members/mem_missing", json={"role": "staff"}).status_code == 404  # owner here, so allowed to try
    other_shop = make_merchant(slug="golden-bun", name="Golden Bun Bakery")
    assert c.post("/api/auth/active-shop", json={"shop_id": other_shop}).status_code == 403


def test_platform_admin_cli_helper(app):
    accounts.ensure_platform_admin(email="ops@example.com", name="Ops", password="admin-password-1")
    with transaction() as db:
        assert db.scalar(select(User.is_platform_admin).where(User.email == "ops@example.com")) is True
    c = TestClient(app, base_url="http://testserver")
    c.headers.update(ORIGIN)
    me = c.post("/api/auth/login", json={"email": "ops@example.com", "password": "admin-password-1"}).json()
    assert me["user"]["is_platform_admin"] is True
