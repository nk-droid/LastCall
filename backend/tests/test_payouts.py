"""Per-shop PayPal payouts: connecting a verified payee, paying the shop directly, and refunding on its behalf."""

from __future__ import annotations

import base64
import json
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import select

from app import clock
from app.config import override_settings, settings
from app.db import transaction
from app.models import Merchant, PaymentAttempt
from app.payments.payee import auth_assertion

from .factories import member_client
from .helpers import buy, ok, shop_id

pytestmark = pytest.mark.usefixtures("bakery")

SHOP_PAYEE = "JUNIPERRYE001"


def _owner(app):
    return member_client(app, shop_id(), "owner")[0]


def _connect(owner, merchant_id: str = SHOP_PAYEE) -> dict:
    return ok(owner.put("/api/merchant/shop/payouts", json={"merchant_id": merchant_id}))


def _claims(assertion: str) -> dict:
    header, claims, signature = assertion.split(".")
    assert json.loads(base64.urlsafe_b64decode(header + "===")) == {"alg": "none"} and signature == ""
    return json.loads(base64.urlsafe_b64decode(claims + "==="))


def test_auth_assertion_names_our_app_and_the_payee():
    assert _claims(auth_assertion("client-123", {"merchant_id": SHOP_PAYEE})) == {"iss": "client-123", "payer_id": SHOP_PAYEE}
    assert auth_assertion("client-123", None) is None


def test_owner_connects_a_verified_payout_account(app, paypal):
    owner = _owner(app)
    view = _connect(owner, "juniperrye001")
    assert view["payouts"] == {"status": "connected", "display": "JUN…001", "verified_at": view["payouts"]["verified_at"], "via": "merchant_id", "email": None}
    assert next(i for i in view["checklist"] if i["key"] == "payouts")["done"] is True
    check = next(o for o in paypal.orders.values() if o["purchase_units"][0]["reference_id"] == "payout-check")
    assert check["purchase_units"][0]["payee"] == {"merchant_id": SHOP_PAYEE} and check["status"] == "CREATED"  # never approved or captured


def test_rejected_and_malformed_payees_are_not_saved(app, paypal):
    owner = _owner(app)
    paypal.invalid_payees.add("BADACCOUNT001")
    rejected = owner.put("/api/merchant/shop/payouts", json={"merchant_id": "BADACCOUNT001"})
    assert rejected.status_code == 422 and rejected.json()["error"]["code"] == "payee_invalid"
    assert owner.put("/api/merchant/shop/payouts", json={"merchant_id": "short"}).status_code == 422
    assert owner.put("/api/merchant/shop/payouts", json={}).status_code == 422
    # Emails can't be verified with PayPal before money moves, so they aren't accepted.
    assert owner.put("/api/merchant/shop/payouts", json={"email": "shop@example.com"}).status_code == 422
    assert ok(owner.get("/api/merchant/shop"))["payouts"] == {"status": "not_connected"}


def test_only_owners_manage_payouts_and_live_shops_keep_one(app):
    manager = member_client(app, shop_id(), "manager")[0]
    assert manager.put("/api/merchant/shop/payouts", json={"merchant_id": SHOP_PAYEE}).status_code == 403
    owner = _owner(app)
    _connect(owner)
    removed = owner.delete("/api/merchant/shop/payouts")
    assert removed.status_code == 422 and removed.json()["error"]["code"] == "payout_required"


def test_checkout_pays_the_shop_and_refunds_assert_the_payee(client, app, paypal):
    owner = _owner(app)
    _connect(owner)
    co, view = buy(client, [("CR-01", 2)])
    assert view["payment_status"] == "CAPTURED"
    unit = paypal.orders[co["paypal_order_id"]]["purchase_units"][0]
    assert unit["payee"] == {"merchant_id": SHOP_PAYEE}
    detail = ok(member_client(app, shop_id(), "manager")[0].post(f"/api/merchant/orders/{co['order_id']}/refund",
                                                                    json={"reason": "Customer cancelled", "return_to_stock": True}))
    assert detail["refund_status"] == "COMPLETED"
    assert _claims(paypal.assertions[-1]) == {"iss": "test-client-id", "payer_id": SHOP_PAYEE}


def test_refund_uses_the_payee_that_was_actually_paid(client, app, paypal):
    owner = _owner(app)
    _connect(owner)
    co, _ = buy(client, [("BR-02", 1)])
    _connect(owner, "NEWACCOUNT001")  # the shop switches accounts after the sale
    ok(member_client(app, shop_id(), "manager")[0].post(f"/api/merchant/orders/{co['order_id']}/refund", json={"reason": "Quality issue"}))
    assert _claims(paypal.assertions[-1])["payer_id"] == SHOP_PAYEE
    with transaction() as db:
        attempt = db.scalar(select(PaymentAttempt).where(PaymentAttempt.order_id == co["order_id"]))
        assert attempt.payee == {"merchant_id": SHOP_PAYEE}
        assert db.get(Merchant, shop_id()).paypal["merchant_id"] == "NEWACCOUNT001"


def test_shop_without_payout_account_is_paid_to_the_platform(client, paypal):
    co, _ = buy(client, [("BR-02", 1)])
    order = paypal.orders[co["paypal_order_id"]]
    assert "payee" not in order["purchase_units"][0]


# --------------------------------------------------------------------------- Connect with PayPal


@pytest.fixture
def connect_on():
    override_settings(**(settings().model_dump() | {"paypal_connect_enabled": True}))


def _start(owner) -> str:
    url = ok(owner.post("/api/merchant/shop/payouts/paypal/start"))["url"]
    query = parse_qs(urlparse(url).query)
    assert query["redirect_uri"] == ["http://localhost:3787/merchant/paypal/return"]
    return query["state"][0]


def test_owner_connects_by_signing_in_with_paypal(app, client, paypal, connect_on):
    assert ok(client.get("/api/config"))["paypal"]["connect"] is True
    owner = _owner(app)
    state = _start(owner)
    view = ok(owner.post("/api/merchant/shop/payouts/paypal/finish", json={"code": paypal.sign_in(SHOP_PAYEE), "state": state}))
    assert view["payouts"] == {"status": "connected", "display": "JUN…001", "verified_at": view["payouts"]["verified_at"], "via": "paypal", "email": "ow…@juniper-rye.com"}
    check = next(o for o in paypal.orders.values() if o["purchase_units"][0]["reference_id"] == "payout-check")
    assert check["purchase_units"][0]["payee"] == {"merchant_id": SHOP_PAYEE}  # still checked as a payee before saving
    co, _ = buy(client, [("CR-01", 1)])
    assert paypal.orders[co["paypal_order_id"]]["purchase_units"][0]["payee"] == {"merchant_id": SHOP_PAYEE}  # customers now pay the shop


def test_a_sign_in_only_connects_the_shop_and_owner_that_started_it(app, paypal, connect_on):
    owner = _owner(app)
    state = _start(owner)
    other_owner = member_client(app, shop_id(), "owner")[0]
    stolen = other_owner.post("/api/merchant/shop/payouts/paypal/finish", json={"code": paypal.sign_in(SHOP_PAYEE), "state": state})
    assert stolen.status_code == 422 and stolen.json()["error"]["code"] == "paypal_connect_invalid"
    forged = owner.post("/api/merchant/shop/payouts/paypal/finish", json={"code": paypal.sign_in(SHOP_PAYEE), "state": state[:-4] + "abcd"})
    assert forged.json()["error"]["code"] == "paypal_connect_invalid"
    clock.advance(timedelta(minutes=11))
    late = owner.post("/api/merchant/shop/payouts/paypal/finish", json={"code": paypal.sign_in(SHOP_PAYEE), "state": state})
    assert late.json()["error"]["code"] == "paypal_connect_expired"
    staff = member_client(app, shop_id(), "manager")[0]
    assert staff.post("/api/merchant/shop/payouts/paypal/start").status_code == 403


def test_unverified_or_rejected_paypal_accounts_are_not_connected(app, paypal, connect_on):
    owner = _owner(app)
    unverified = owner.post("/api/merchant/shop/payouts/paypal/finish", json={"code": paypal.sign_in(SHOP_PAYEE, verified=False), "state": _start(owner)})
    assert unverified.json()["error"]["code"] == "paypal_unverified"
    reused = owner.post("/api/merchant/shop/payouts/paypal/finish", json={"code": "CODE-NOT-ISSUED", "state": _start(owner)})
    assert reused.json()["error"]["code"] == "paypal_connect_failed"
    paypal.invalid_payees.add("BLOCKEDPAYEE1")
    blocked = owner.post("/api/merchant/shop/payouts/paypal/finish", json={"code": paypal.sign_in("BLOCKEDPAYEE1"), "state": _start(owner)})
    assert blocked.json()["error"]["code"] == "payee_invalid"
    assert ok(owner.get("/api/merchant/shop"))["payouts"] == {"status": "not_connected"}


def test_connect_with_paypal_is_off_unless_configured(app, client):
    assert ok(client.get("/api/config"))["paypal"]["connect"] is False
    off = _owner(app).post("/api/merchant/shop/payouts/paypal/start")
    assert off.status_code == 422 and off.json()["error"]["code"] == "paypal_connect_off"
