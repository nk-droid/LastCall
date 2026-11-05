"""Customer emails and SMTP delivery."""

from __future__ import annotations

import re

import pytest
from sqlalchemy import select

from app.config import override_settings, settings
from app.db import transaction
from app.models import EmailMessage
from app.services import mail

from .conftest import new_client
from .factories import last_email, member_client
from .helpers import buy, ok, shop_id

pytestmark = pytest.mark.usefixtures("bakery")


class FakeSMTP:
    sent: list = []
    fail = False

    def __init__(self, host, port, timeout):
        self.host = host

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self):
        pass

    def login(self, user, password):
        self.user = user

    def send_message(self, message):
        if FakeSMTP.fail:
            raise OSError("connection refused")
        FakeSMTP.sent.append(message)


def test_paid_order_emails_a_receipt_with_code_and_private_link(client, app):
    co, view = buy(client, [("CR-01", 2)], customer={"name": "Maya Rivera", "email": "maya@example.com"})
    receipt = last_email("maya@example.com", "order_confirmed")
    assert receipt.subject.startswith(f"Order {view['number']} confirmed")
    assert view["pickup"]["code"] in receipt.text_body and "code" not in receipt.context
    assert "2 × Butter croissant" in receipt.text_body and "$5.00" in receipt.text_body
    token = re.search(r"/orders/" + co["order_id"] + r"\?t=([0-9a-f]+)", receipt.text_body).group(1)
    stranger = new_client(app)
    assert stranger.get(f"/api/orders/{co['order_id']}").status_code == 404
    assert ok(stranger.get(f"/api/orders/{co['order_id']}", params={"t": token}))["id"] == co["order_id"]


def test_ready_and_refund_emails(client, app):
    co, _ = buy(client, [("BR-02", 1)], slot_index=2, customer={"name": "Sam", "email": "sam@example.com"})
    manager = member_client(app, shop_id(), "manager")[0]
    ok(manager.post(f"/api/merchant/orders/{co['order_id']}/fulfillment", json={"action": "mark_ready"}))
    assert last_email("sam@example.com", "order_ready").subject.endswith("is ready for pickup")
    ok(manager.post(f"/api/merchant/orders/{co['order_id']}/refund", json={"reason": "Quality issue", "return_to_stock": False}))
    assert last_email("sam@example.com", "refund_completed").subject == "Refund of $2.00 completed"


def test_phone_only_orders_send_no_email(client):
    buy(client, [("BR-02", 1)], customer={"name": "Leo", "phone": "+1 415 555 0100"})
    with transaction() as db:
        assert db.scalars(select(EmailMessage).where(EmailMessage.template == "order_confirmed")).all() == []


def test_outbox_is_skipped_without_smtp_and_sent_with_it(client, monkeypatch):
    buy(client, [("BR-02", 1)], customer={"name": "Ana", "email": "ana@example.com"})
    assert mail.deliver_pending() == {"sent": 0, "skipped": 1, "failed": 0}
    override_settings(**(settings().model_dump() | {"smtp_host": "smtp.example.com", "smtp_username": "bot", "smtp_password": "x"}))
    monkeypatch.setattr(mail.smtplib, "SMTP", FakeSMTP)
    FakeSMTP.sent = []
    buy(client, [("CR-01", 1)], customer={"name": "Ana", "email": "ana@example.com"})
    assert mail.deliver_pending() == {"sent": 1, "skipped": 0, "failed": 0}
    message = FakeSMTP.sent[0]
    assert message["To"] == "ana@example.com" and message["From"] == settings().smtp_from
    assert message.get_body(("html",)) is not None


def test_failed_delivery_retries_then_gives_up(client, monkeypatch):
    override_settings(**(settings().model_dump() | {"smtp_host": "smtp.example.com"}))
    monkeypatch.setattr(mail.smtplib, "SMTP", FakeSMTP)
    FakeSMTP.fail = True
    try:
        buy(client, [("BR-02", 1)], customer={"name": "Ana", "email": "ana@example.com"})
        for _ in range(mail.MAX_ATTEMPTS):
            mail.deliver_pending()
        with transaction() as db:
            row = db.scalar(select(EmailMessage).where(EmailMessage.template == "order_confirmed"))
            assert row.status == "failed" and row.attempts == mail.MAX_ATTEMPTS and "connection refused" in row.last_error
    finally:
        FakeSMTP.fail = False
