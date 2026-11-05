"""Platform ops: admin-only evidence trail, reconciliation, traces and gated failure injection."""

from __future__ import annotations

import pytest

from app.config import override_settings, settings
from app.services import accounts

from .conftest import new_client
from .factories import member_client
from .helpers import approve, buy, capture, ok, quote_lines, shop_id, start_checkout

pytestmark = pytest.mark.usefixtures("bakery")


def _admin(app):
    accounts.ensure_platform_admin(email="ops@lastcall.app", name="LastCall Ops", password="ops-password-123")
    c = new_client(app)
    ok(c.post("/api/auth/login", json={"email": "ops@lastcall.app", "password": "ops-password-123"}))
    return c


def test_ops_routes_need_a_platform_admin(client, app):
    owner = member_client(app, shop_id(), "owner")[0]
    for path in ("/api/ops/status", "/api/ops/payments", "/api/ops/webhooks", "/api/ops/ai-invocations", "/api/ops/jobs", "/api/ops/audit"):
        assert client.get(path).status_code == 401
        assert owner.get(path).status_code == 403


def test_payments_trace_and_audit_show_the_evidence(client, app):
    co, _ = buy(client, [("CR-01", 1)])
    admin = _admin(app)
    payment = ok(admin.get("/api/ops/payments"))["payments"][0]
    assert payment["state"] == "CAPTURED" and payment["capture_id"] and payment["order_id"] == co["order_id"]
    actions = [e["action"] for e in ok(admin.get(f"/api/ops/trace/{payment['trace_id']}"))["events"]]
    assert actions.index("quote_created") < actions.index("reservation_created") < actions.index("capture_verified")
    assert ok(admin.get("/api/ops/audit", params={"limit": 5}))["events"]
    status = ok(admin.get("/api/ops/status"))
    assert status["shops"] == {"live": 1} and status["payments_unresolved"] == 0


def test_failure_injection_is_off_unless_enabled(client, app, paypal):
    admin = _admin(app)
    blocked = admin.post("/api/ops/faults", json={"kind": "capture_response_lost"})
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "faults_disabled"
    override_settings(**(settings().model_dump() | {"ops_faults_enabled": True}))
    ok(admin.post("/api/ops/faults", json={"kind": "capture_response_lost"}))
    assert [f["kind"] for f in ok(admin.get("/api/ops/faults"))["armed"]] == ["capture_response_lost"]
    co = start_checkout(client, quote_lines(client, [("BR-02", 1)])["id"])
    approve(co["paypal_order_id"])
    assert capture(client, co)["payment_status"] == "OUTCOME_UNKNOWN"
    attempt = ok(admin.get("/api/ops/payments"))["payments"][0]
    assert ok(admin.post(f"/api/ops/payments/{attempt['id']}/reconcile"))["result"] == "captured"
    assert len(paypal.captures(co["paypal_order_id"])) == 1
