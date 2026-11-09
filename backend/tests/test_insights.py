"""Today overview and insights: computed from orders, inventory and events, with evidence."""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from app.db import transaction
from app.models import MetricSnapshot
from app.services import insights, overview

from .factories import member_client
from .fixtures import seed_bakery
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
    assert len(today["slots"]) == 6
    assert today["sales"]["paid_orders"] == 1 and today["sales"]["amount_minor"] == 500
    # The pickup queue holds the paid order (with its items) and the checkout that is still paying.
    paid, paying = sorted(today["open_orders"], key=lambda o: o["payment_status"] != "CAPTURED")
    assert paid["fulfillment_status"] == "NEW" and paid["lines"][0]["qty"] == 2 and paid["hold_expires_at"] is None
    assert paying["payment_status"] != "CAPTURED" and paying["lines"][0]["qty"] == 1
    assert {r["sku"]: r["sold_today"] for r in today["stock"]}["CR-01"] == 2


def test_refunds_only_count_toward_their_own_shop(client, app):
    co, _ = buy(client, [("CR-01", 2)])
    ok(member_client(app, shop_id(), "manager")[0].post(f"/api/merchant/orders/{co['order_id']}/refund", json={"reason": "Quality issue"}))
    other = member_client(app, seed_bakery(slug="copper-kettle", name="Copper Kettle Café"), "staff")[0]
    assert ok(other.get("/api/merchant/insights"))["money"]["refunded_minor"] == 0
    assert ok(other.get("/api/merchant/insights/summary"))["headline"]["refunded_minor"] == 0
    mine = ok(member_client(app, shop_id(), "staff")[0].get("/api/merchant/insights/summary"))["headline"]
    assert mine["refunded_minor"] == 500 and mine["net_sales_minor"] == 0


def test_summary_answers_the_owners_questions(client, app):
    buy(client, [("CR-01", 2)])
    drain_jobs()
    staff = member_client(app, shop_id(), "staff")[0]
    week = ok(staff.get("/api/merchant/insights/summary"))
    head = week["headline"]
    assert head["net_sales_minor"] == 500 and head["orders"] == 1 and head["sold_units"] == 2
    assert head["menu_value_minor"] >= head["paid_value_minor"] > 0 and head["change"] is None  # nothing to compare with yet
    assert len(week["sales_by_day"]) == 7 and week["sales_by_day"][-1]["today"] and week["sales_by_day"][-1]["orders"] == 1
    assert len(week["orders_by_hour"]) == 24 and sum(week["orders_by_hour"]) == 1
    assert week["busiest"] is None  # too few orders to call a busy stretch
    item = next(i for i in week["items"] if i["sold"])
    assert item["sold"] == 2 and item["suggestion"]["kind"] == "early"  # one day of history isn't enough to suggest
    assert week["missed"]["total"] == 0 and week["caution"]
    assert len(ok(staff.get("/api/merchant/insights/summary?period=30d"))["sales_by_day"]) == 30
    assert staff.get("/api/merchant/insights/summary?period=today").status_code == 422
