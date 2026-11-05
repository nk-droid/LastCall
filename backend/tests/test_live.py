"""Live updates: flush-time NOTIFY, the per-process broker, and topic authorization on /api/live."""

from __future__ import annotations

import asyncio

import pytest

from app import db as app_db
from app.db import transaction
from app.models import InventoryLot
from app.realtime import Broker, install

from .conftest import new_client
from .factories import member_client
from .helpers import buy, ok, product_id, shop_id

pytestmark = pytest.mark.usefixtures("bakery")


def _collect(topics: list[str], action, expect: int) -> list[str]:
    broker = Broker()
    broker.configure(app_db.libpq_dsn())

    async def run() -> list[str]:
        queue, unsubscribe = broker.subscribe(topics)
        await asyncio.sleep(0.5)  # listener connected
        await asyncio.to_thread(action)
        got: list[str] = []
        try:
            while len(got) < expect:
                got.append(await asyncio.wait_for(queue.get(), timeout=5))
        finally:
            unsubscribe()
            broker.stop()
        return got

    return asyncio.run(run())


def test_stock_changes_reach_shop_subscribers():
    install()
    pid = product_id("CR-01")

    def edit() -> None:
        with transaction() as db:
            lot = db.query(InventoryLot).filter(InventoryLot.product_id == pid).one()
            lot.surplus_qty -= 1

    assert _collect([f"shop:{shop_id()}:stock"], edit, 1) == [f"shop:{shop_id()}:stock"]


def test_order_changes_reach_order_and_queue_subscribers(client):
    install()
    holder: dict = {}

    def purchase() -> None:
        holder["co"], _ = buy(client, [("BR-02", 1)])

    got = _collect([f"shop:{shop_id()}:orders"], purchase, 1)
    assert got == [f"shop:{shop_id()}:orders"]


def test_live_topics_are_authorized(client, app):
    co, _ = buy(client, [("BR-02", 1)])
    stranger = new_client(app)
    assert stranger.get("/api/live", params={"topics": f"order:{co['order_id']}"}).status_code == 404
    assert stranger.get("/api/live", params={"topics": f"shop:{shop_id()}:orders"}).status_code == 403
    assert stranger.get("/api/live", params={"topics": "shop:mer_nope:stock"}).status_code == 404
    assert stranger.get("/api/live", params={"topics": "weather:today"}).status_code == 422
    owner = member_client(app, shop_id(), "owner")[0]
    with owner.stream("GET", "/api/live", params={"topics": f"shop:{shop_id()}:orders"}) as response:
        assert response.status_code == 200 and response.headers["content-type"].startswith("text/event-stream")
        assert next(response.iter_lines()) == "retry: 5000"
    assert ok(client.get("/api/merchants"))  # the app keeps serving after a stream closes
