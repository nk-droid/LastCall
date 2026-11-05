"""Today overview and insights: computed from orders, inventory and events, with evidence."""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from app.db import transaction
from app.models import MetricSnapshot
from app.services import insights, overview

from .factories import member_client
from .helpers import buy, drain_jobs, ok, quote_lines, shop_id, start_checkout

pytestmark = pytest.mark.usefixtures("bakery")


def test_insights_compute_from_orders_and_events(client, app):
    buy(client, [("CR-01", 2)])
    drain_jobs()
    data = ok(member_client(app, shop_id(), "staff")[0].get("/api/merchant/insights"))
    assert data["money"]["gross_merchandise_value_minor"] == 500
    assert data["money"]["net_captured_sales_minor"] == 500
    assert data["metrics"]["checkout_completion"]["numerator"] == 1
    assert data["units"]["sold"] == 2
    assert data["waste_avoided"]["reported"] is False
    assert "demo" not in (data.get("caution") or "").lower()


def test_snapshots_keep_one_row_per_day(client):
    buy(client, [("BR-02", 1)])
    insights.snapshot_all("today")
    insights.snapshot_all("today")
    with transaction() as db:
        assert db.scalar(select(func.count()).select_from(MetricSnapshot)) == 1


def test_today_overview_counts_stock_orders_and_payouts(client, app):
    buy(client, [("CR-01", 2)])
    start_checkout(client, quote_lines(client, [("BR-02", 1)])["id"])
    overview.check_paypal_connection()
    today = ok(member_client(app, shop_id(), "staff")[0].get("/api/merchant/overview"))
    assert today["orders"]["awaiting_pickup"] == 1 and today["orders"]["payment_pending"] == 1
    assert today["counters"]["committed_units"] == 2 and today["counters"]["reserved_units"] == 1
    assert today["counters"]["sold_units_today"] == 2
    assert today["paypal"]["payouts"] == {"status": "not_connected"} and today["paypal"]["reachable"] is True
    assert len(today["slots"]) == 6 and today["recent_orders"]
