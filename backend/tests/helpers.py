"""Shared test flows that drive the public API the way the web app does."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select

from app import clock
from app.db import transaction
from app.models import Merchant, Product
from app.payments import get_client
from app.services import jobs
from app.services.catalog import availability

from .fake_paypal import FakePayPal

SHOP = "juniper-rye"
STRICT_NO_NUTS = {"exclusions": [{"code": "tree_nuts", "severity": "strict"}, {"code": "peanuts", "severity": "strict"}]}


def ok(response, status: int = 200) -> dict[str, Any]:
    assert response.status_code == status, f"{response.status_code}: {response.text}"
    return response.json()


def parse(client: TestClient, text: str, controls: dict[str, Any] | None = None, merchant: str = SHOP, use_ai: bool = True) -> dict[str, Any]:
    return ok(client.post("/api/intents/parse", json={"text": text, "controls": controls or {}, "use_ai": use_ai, "merchant": merchant}))


def propose(client: TestClient, text: str = "snacks for 4 people under $18, no nuts", controls: dict[str, Any] | None = None,
            merchant: str = SHOP) -> dict[str, Any]:
    parsed = parse(client, text, controls if controls is not None else STRICT_NO_NUTS, merchant=merchant)
    assert parsed["state"] == "ready", parsed
    return ok(client.post("/api/bundles/propose", json={"intent_id": parsed["intent_id"]}))


def bookable_slot(client: TestClient, merchant: str = SHOP, index: int = 0) -> str:
    slots = ok(client.get(f"/api/merchants/{merchant}/pickup-slots"))["slots"]
    return [s["id"] for s in slots if s["bookable"]][index]


def quote_lines(client: TestClient, lines: list[tuple[str, int]], slot_id: str | None = None, intent_id: str | None = None,
                slot_index: int = 0, merchant: str = SHOP) -> dict[str, Any]:
    body: dict[str, Any] = {"lines": [{"sku": s, "qty": q} for s, q in lines], "merchant": merchant,
                            "pickup_slot_id": slot_id or bookable_slot(client, merchant, slot_index)}
    if intent_id:
        body["intent_id"] = intent_id
    return ok(client.post("/api/quotes", json=body))


def reserve(client: TestClient, quote_id: str) -> dict[str, Any]:
    return ok(client.post("/api/reservations", json={"quote_id": quote_id}))


def shop_id(slug: str = SHOP) -> str:
    with transaction() as db:
        return db.scalar(select(Merchant.id).where(Merchant.slug == slug))


def product_id(sku: str, slug: str = SHOP) -> str:
    with transaction() as db:
        return db.scalar(select(Product.id).join(Merchant, Merchant.id == Product.merchant_id).where(Merchant.slug == slug, Product.sku == sku))


def available(sku: str, slug: str = SHOP) -> int:
    with transaction() as db:
        pid = product_id(sku, slug)
        return availability(db, shop_id(slug), clock.now(), [pid])[pid].available


def counter_sale(staff: TestClient, sku: str, quantity: int, slug: str = SHOP) -> dict[str, Any]:
    """Staff record a sale at the counter (the realistic way stock disappears mid-checkout)."""
    return ok(staff.post("/api/merchant/inventory", json={"product_id": product_id(sku, slug), "action": "counter_sale", "delta": quantity}))


def sell_out(staff: TestClient, sku: str, leave: int = 0, slug: str = SHOP) -> None:
    qty = available(sku, slug) - leave
    if qty > 0:
        counter_sale(staff, sku, qty, slug)


def drain_jobs(rounds: int = 5) -> None:
    for _ in range(rounds):
        if jobs.run_due("test", include_periodic=False) == 0:
            break


def policy_version(slug: str = SHOP) -> int:
    with transaction() as db:
        return db.scalar(select(Merchant.policy_version).where(Merchant.slug == slug))


def start_checkout(client: TestClient, quote_id: str, merchant: str = SHOP, customer: dict[str, Any] | None = None) -> dict[str, Any]:
    reserve(client, quote_id)
    return ok(client.post("/api/checkout/paypal/order", json={
        "quote_id": quote_id,
        "customer": customer or {"name": "Maya Rivera", "email": "maya@example.com"},
        "accept_policies": True,
        "policy_version": policy_version(merchant),
    }))


def paypal_stand_in() -> FakePayPal:
    return get_client().inner  # type: ignore[return-value]


def approve(paypal_order_id: str) -> None:
    """The buyer approves the payment in PayPal's window."""
    paypal_stand_in().approve(paypal_order_id)


def capture(client: TestClient, checkout: dict[str, Any]) -> dict[str, Any]:
    return ok(client.post("/api/checkout/paypal/capture", json={"order_id": checkout["order_id"], "paypal_order_id": checkout["paypal_order_id"]}))


def buy(client: TestClient, lines: list[tuple[str, int]], slot_index: int = 0, merchant: str = SHOP,
        customer: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    quote = quote_lines(client, lines, slot_index=slot_index, merchant=merchant)
    checkout = start_checkout(client, quote["id"], merchant=merchant, customer=customer)
    approve(checkout["paypal_order_id"])
    return checkout, capture(client, checkout)
