"""Small builders for test data that doesn't go through the public API."""

from __future__ import annotations

import re

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import transaction
from app.ids import new_id
from app.models import EmailMessage, Membership, Merchant
from app.security import hash_password

from .conftest import ORIGIN

PASSWORD = "correct-horse-battery"


def make_merchant(slug: str = "juniper-rye", name: str = "Juniper & Rye Bakehouse", status: str = "live", **fields) -> str:
    with transaction() as db:
        merchant = Merchant(id=new_id("mer"), slug=slug, name=name, status=status, timezone=fields.pop("timezone", "America/Los_Angeles"),
                            currency="USD", **fields)
        db.add(merchant)
        return merchant.id


def signup(client: TestClient, email: str, name: str = "Test Person", password: str = PASSWORD) -> dict:
    response = client.post("/api/auth/signup", json={"name": name, "email": email, "password": password})
    assert response.status_code == 201, response.text
    return response.json()


def add_member(user_id: str, merchant_id: str, role: str) -> str:
    with transaction() as db:
        row = Membership(id=new_id("mem"), user_id=user_id, merchant_id=merchant_id, role=role)
        db.add(row)
        return row.id


def member_client(app, merchant_id: str, role: str, email: str | None = None) -> tuple[TestClient, dict]:
    """A signed-in client whose account is a ``role`` member of the merchant."""
    client = TestClient(app, base_url="http://testserver")
    client.headers.update(ORIGIN)
    view = signup(client, email or f"{role}-{new_id('x')[-6:]}@example.com", name=f"{role.title()} Person")
    add_member(view["user"]["id"], merchant_id, role)
    return client, view


def last_email(to: str, template: str | None = None) -> EmailMessage:
    with transaction() as db:
        stmt = select(EmailMessage).where(EmailMessage.to_email == to)
        if template:
            stmt = stmt.where(EmailMessage.template == template)
        message = db.scalars(stmt.order_by(EmailMessage.created_at.desc())).first()
        assert message is not None, f"no email to {to}"
        db.expunge(message)
        return message


def token_from(message: EmailMessage, path: str) -> str:
    match = re.search(rf"{re.escape(path)}/([A-Za-z0-9_-]+)", message.text_body)
    assert match, message.text_body
    return match.group(1)


def password_hash(password: str = PASSWORD) -> str:
    return hash_password(password)
