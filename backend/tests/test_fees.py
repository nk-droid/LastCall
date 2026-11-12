"""LastCall's revenue: 10% of each paid order's items (min $0.25), recorded on capture, adjusted by refunds, billed weekly by PayPal invoice."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select

from app import clock
from app.db import transaction
from app.models import FeeInvoice, PlatformFee
from app.payments.base import PayPalError
from app.services import fees, jobs

from .conftest import new_client
from .factories import member_client
from .helpers import buy, drain_jobs, ok, shop_id

pytestmark = pytest.mark.usefixtures("bakery")


@pytest.fixture
def owner(app):
    return member_client(app, shop_id(), "owner", email="owner@juniper-rye.com")[0]


def _fee(order_id: str) -> PlatformFee:
    with transaction() as db:
        fee = db.scalar(select(PlatformFee).where(PlatformFee.order_id == order_id))
        db.expunge(fee)
        return fee


def _next_week() -> None:
    clock.advance(timedelta(days=7))
    jobs.run_due("test", include_periodic=True)  # the weekly run picks up last week's fees


def test_fee_is_ten_percent_of_the_items_with_a_minimum_never_above_the_items():
    assert fees.fee_for(500, 1000, 25) == 50
    assert fees.fee_for(150, 1000, 25) == 25  # the minimum
    assert fees.fee_for(20, 1000, 25) == 20  # never more than the items
    assert fees.fee_for(1005, 1000, 25) == 101  # half a cent rounds up
    assert fees.fee_for(0, 1000, 25) == 0


def test_a_paid_order_carries_the_fee_once_and_shoppers_pay_nothing_extra(app, client, owner, paypal):
    co, captured = buy(client, [("CR-01", 2)])
    order = ok(client.get(f"/api/orders/{co['order_id']}"))
    assert order["totals"]["fees_minor"] == 0 and order["amount_minor"] == 500  # the shop's price, nothing added
    fee = _fee(co["order_id"])
    assert (fee.basis_minor, fee.rate_bps, fee.min_minor, fee.fee_minor, fee.billed_minor) == (500, 1000, 25, 50, 0)
    paypal.deliver_webhooks()  # PAYMENT.CAPTURE.COMPLETED replays the capture: still one fee
    drain_jobs()
    with transaction() as db:
        assert len(db.scalars(select(PlatformFee)).all()) == 1
    detail = ok(owner.get(f"/api/merchant/orders/{co['order_id']}"))
    assert detail["platform_fee"] == {"fee_minor": 50, "net_minor": 450, "currency": "USD", "label": "10% of each order's items (min $0.25)", "billed": False}
    shop = ok(owner.get("/api/merchant/shop"))["fees"]
    assert shop["terms"]["label"] == "10% of each order's items (min $0.25)" and shop["week"] == {"orders": 1, "fee_minor": 50}
    assert shop["next_invoice_minor"] == 50 and shop["recipient"] == "owner@juniper-rye.com" and shop["invoices"] == []


def test_refunds_take_the_fee_down_and_a_full_refund_waives_it(client, owner):
    co, _ = buy(client, [("CR-01", 2)])
    ok(owner.post(f"/api/merchant/orders/{co['order_id']}/refund", json={"reason": "One croissant was burnt", "amount_minor": 250}))
    assert (_fee(co["order_id"]).basis_minor, _fee(co["order_id"]).fee_minor) == (250, 25)
    ok(owner.post(f"/api/merchant/orders/{co['order_id']}/refund", json={"reason": "Customer cancelled"}))
    assert (_fee(co["order_id"]).basis_minor, _fee(co["order_id"]).fee_minor) == (0, 0)
    assert ok(owner.get(f"/api/merchant/orders/{co['order_id']}"))["platform_fee"]["net_minor"] == 0


def test_each_week_the_shop_gets_one_paypal_invoice_and_paying_it_is_recorded(app, client, owner, paypal):
    first, _ = buy(client, [("CR-01", 2)])
    second, _ = buy(client, [("CC-10", 1)])  # $1.50 of items: the $0.25 minimum
    jobs.run_due("test", include_periodic=True)
    with transaction() as db:
        assert db.scalars(select(FeeInvoice)).all() == []  # this week's fees wait for the week to end
    _next_week()

    with transaction() as db:
        invoice = db.scalars(select(FeeInvoice)).one()
        db.expunge(invoice)
    assert (invoice.status, invoice.amount_minor, invoice.orders, invoice.recipient_email) == ("SENT", 75, 2, "owner@juniper-rye.com")  # $0.50 + $0.25
    sent = paypal.invoices[invoice.paypal_invoice_id]
    assert sent["amount"]["value"] == "0.75" and sent["invoicer"] == {"business_name": "LastCall"}
    assert [(i["unit_amount"]["value"], i["description"].split(": ", 1)[1]) for i in sent["items"]] == [("0.50", "10% of $5.00 items"), ("0.25", "minimum fee")]
    assert _fee(first["order_id"]).billed_minor == 50 and _fee(second["order_id"]).billed_minor == 25

    shop = ok(owner.get("/api/merchant/shop"))["fees"]
    assert shop["next_invoice_minor"] == 0
    assert shop["invoices"][0] | {"sent_at": None} == {
        "id": invoice.id, "number": invoice.number, "status": "SENT", "amount_minor": 75, "credit_minor": 0, "currency": "USD", "orders": 2,
        "period_label": "Up to Nov 9", "payer_url": f"https://www.sandbox.paypal.com/invoice/p/#{invoice.paypal_invoice_id}", "sent_at": None, "paid_at": None}
    assert ok(owner.get(f"/api/merchant/orders/{first['order_id']}"))["platform_fee"]["billed"] is True

    paypal.pay_invoice(invoice.paypal_invoice_id)
    paypal.deliver_webhooks()
    drain_jobs()
    assert ok(owner.get("/api/merchant/shop"))["fees"]["invoices"][0]["status"] == "PAID"
    _next_week()
    with transaction() as db:
        assert len(db.scalars(select(FeeInvoice)).all()) == 1  # nothing new to bill


def _bill_now() -> dict:
    return fees.bill_all(until=clock.now() + timedelta(seconds=1), actor="test")


def test_a_refund_after_billing_is_taken_off_the_next_invoice(client, owner, paypal):
    refunded, _ = buy(client, [("CR-01", 2)])
    assert _bill_now()["sent"] == 1
    ok(owner.post(f"/api/merchant/orders/{refunded['order_id']}/refund", json={"reason": "Customer cancelled"}))
    assert (_fee(refunded["order_id"]).fee_minor, _fee(refunded["order_id"]).billed_minor) == (0, 50)
    buy(client, [("CR-01", 4)])  # $10.00 of items: $1.00
    assert _bill_now()["sent"] == 1
    with transaction() as db:
        latest = db.scalars(select(FeeInvoice).order_by(FeeInvoice.number.desc())).first()
        db.expunge(latest)
    assert (latest.charges_minor, latest.credit_minor, latest.amount_minor, latest.orders) == (100, 50, 50, 2)
    sent = paypal.invoices[latest.paypal_invoice_id]
    assert [i["unit_amount"]["value"] for i in sent["items"]] == ["1.00"] and sent["amount"]["value"] == "0.50"  # the refunded fee as a discount
    assert _fee(refunded["order_id"]).billed_minor == 0


def test_a_cancelled_or_failed_invoice_puts_its_fees_back_to_be_billed(client, owner, paypal, monkeypatch):
    co, _ = buy(client, [("CR-01", 2)])

    def rejected(body, request_id):
        raise PayPalError(422, "UNPROCESSABLE_ENTITY", "Recipient email is invalid", issue="INVALID_EMAIL")

    monkeypatch.setattr(paypal, "create_invoice", rejected)
    assert _bill_now()["failed"] == 1
    with transaction() as db:
        failed = db.scalars(select(FeeInvoice)).one()
        assert failed.status == "FAILED" and failed.last_error["issue"] == "INVALID_EMAIL"
    assert (_fee(co["order_id"]).billed_minor, _fee(co["order_id"]).invoice_id) == (0, None)

    monkeypatch.undo()
    assert _bill_now()["sent"] == 1
    with transaction() as db:
        paypal_id = db.scalars(select(FeeInvoice).where(FeeInvoice.status == "SENT")).one().paypal_invoice_id
    assert _fee(co["order_id"]).billed_minor == 50
    paypal.cancel_invoice(paypal_id)
    clock.advance(timedelta(minutes=16))
    jobs.run_due("test", include_periodic=True)  # the status check sees the cancellation
    assert (_fee(co["order_id"]).billed_minor, _fee(co["order_id"]).invoice_id) == (0, None)
    assert ok(owner.get("/api/merchant/shop"))["fees"]["next_invoice_minor"] == 50


def test_platform_ops_sees_revenue_and_can_bill_now(app, client, owner):
    from app.services import accounts

    buy(client, [("CR-01", 2)])
    accounts.ensure_platform_admin(email="ops@lastcall.app", name="LastCall Ops", password="ops-password-123")
    admin = new_client(app)
    ok(admin.post("/api/auth/login", json={"email": "ops@lastcall.app", "password": "ops-password-123"}))
    assert owner.post("/api/ops/fees/invoice-now").status_code == 403
    before = ok(admin.get("/api/ops/fees"))
    assert (before["week"], before["unbilled_minor"], before["invoiced_open_minor"]) == ({"orders": 1, "fee_minor": 50}, 50, 0)
    after = ok(admin.post("/api/ops/fees/invoice-now"))
    assert after["results"]["sent"] == 1 and after["unbilled_minor"] == 0 and after["invoiced_open_minor"] == 50
    assert after["invoices"][0]["shop"] == "Juniper & Rye Bakehouse"
