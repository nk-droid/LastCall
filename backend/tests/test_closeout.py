"""A3 Close-out agent: an hour before pickup ends, an agent proposes end-of-day changes; a manager applies them.

The tests pin what the agent can never do (raise a price, go below the price floor, drop below held or
paid units, invent stock, close a booked slot), that applying is exactly the manual change, and the
schedule (once a day at the lead time, a 24-hour shop closes at end of day, plans expire at close)."""

from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from app import clock
from app.ai import provider as ai_provider
from app.db import transaction
from app.models import AgentProposal, AgentRun, AgentStep, AuditEvent, MerchantAlert, Order, Price, Product
from app.seed.catalogs import NIGHT_OWL_CATALOG
from app.services import closeout

from .factories import member_client
from .fixtures import seed_bakery
from .helpers import buy, counter_sale, ok, product_id, quote_lines, reserve, shop_id

pytestmark = pytest.mark.usefixtures("bakery")
TASK = "closeout"


@pytest.fixture
def manager(app):
    return member_client(app, shop_id(), "manager")[0]


@pytest.fixture
def staff(app):
    return member_client(app, shop_id(), "staff")[0]


def at(hh: int, mm: int = 0) -> None:
    """Move the frozen clock (3:00 PM local) forward to hh:mm today."""
    now = clock.now()
    target = clock.combine_local(clock.local_date("America/Los_Angeles"), f"{hh:02d}:{mm:02d}", "America/Los_Angeles")
    clock.advance(target - now)


def read_all() -> dict:
    return {"tool_calls": [{"name": "get_stock", "args": {}}, {"name": "get_pickup_slots", "args": {}}, {"name": "get_today_sales", "args": {}}]}


def plan_with(*actions: dict, summary: str = "Clear the slow sellers.") -> dict:
    return {"tool_calls": [{"name": "propose_plan", "args": {"summary": summary, "actions": list(actions)}}]}


def slots_seen(messages: list[dict]) -> list[dict]:
    return next(json.loads(m["content"])["slots"] for m in messages if m["role"] == "tool" and '"slots"' in m["content"])


def plan_row() -> AgentProposal:
    with transaction() as db:
        row = db.scalars(select(AgentProposal).where(AgentProposal.status != "superseded").order_by(AgentProposal.created_at.desc())).first()
        db.expunge(row)
        return row


def by_id(plan: dict) -> dict:
    return {a["id"]: a for a in plan["actions"]}


def test_the_plan_starts_once_at_the_lead_time_and_stays_within_the_price_floor(manager):
    assert closeout.run_due()["started"] == 0  # 3:00 PM: pickup ends at 7:00 PM, the plan starts at 6:00 PM
    at(18, 5)
    assert closeout.run_due()["started"] == 1
    assert closeout.run_due()["started"] == 0  # once a day

    current = ok(manager.get("/api/merchant/closeout"))
    plan = current["plan"]
    assert current["schedule"] == {"enabled": True, "lead_minutes": 60, "runs_at": current["schedule"]["runs_at"],
                                   "runs_at_label": "6:00 PM", "closes_at_label": "7:00 PM"}
    assert plan["status"] == "pending" and plan["source"] == "rules" and plan["expires_label"] == "7:00 PM"
    cuts = [a for a in plan["actions"] if a["status"] == "proposed"]
    assert cuts and all(a["type"] == "lower_price" for a in cuts)
    with transaction() as db:
        for a in cuts:
            price = db.scalars(select(Price).where(Price.sku == a["sku"]).order_by(Price.effective_at.desc())).first()
            assert price.sale_minor > a["new_sale_minor"] >= -(-price.reference_minor * 30 // 100)
        alert = db.scalars(select(MerchantAlert).where(MerchantAlert.kind == "closeout_ready", MerchantAlert.entity_id == plan["id"])).one()
    assert alert.resolved_at is None and "Close-out plan ready" in alert.message


def test_actions_that_break_a_bound_are_dropped_with_the_reason(client, manager, fixture_llm):
    at(17, 35)  # leaves two upcoming slots: 6:00 (empty) and 6:30
    _, order_view = buy(client, [("SC-04", 1)], slot_index=1)  # a paid unit, booked in the 6:30 slot
    reserve(client, quote_lines(client, [("SC-04", 2)], slot_index=1)["id"])  # two held units
    with transaction() as db:
        booked_slot = db.get(Order, order_view["id"]).pickup_slot_id

    def plan(messages):
        free = next(s["slot_id"] for s in slots_seen(messages) if s["booked"] == 0 and s["status"] == "open")
        return plan_with(
            {"type": "lower_price", "sku": "CR-01", "new_price_dollars": 0.5, "reason": "dump it"},   # below the 30% floor ($1.20)
            {"type": "lower_price", "sku": "CR-01", "new_price_dollars": 3.0, "reason": "raise it"},  # a raise
            {"type": "lower_price", "sku": "CR-01", "new_price_dollars": 1.75, "reason": "slow seller"},
            {"type": "lower_price", "sku": "CR-01", "new_price_dollars": 1.5, "reason": "again"},     # second price change
            {"type": "adjust_surplus", "sku": "BR-02", "delta": 5, "reason": "more rolls"},           # more than on hand
            {"type": "adjust_surplus", "sku": "SC-04", "delta": -6, "reason": "pull them"},           # below held + paid
            {"type": "close_slot", "slot_id": booked_slot, "reason": "quiet"},
            {"type": "set_slot_capacity", "slot_id": booked_slot, "capacity": 0, "reason": "quiet"},
            {"type": "close_slot", "slot_id": free, "reason": "no bookings"},
            {"type": "pause_listing", "sku": "NOPE-1", "reason": "?"},
        )

    fixture_llm.queue(TASK, read_all(), plan)
    actions = by_id(ok(manager.post("/api/merchant/closeout/run")))
    status = {k: (v["status"], v.get("note", "")) for k, v in actions.items()}
    assert status["a1"][0] == "dropped" and "lowest allowed price ($1.20" in status["a1"][1]
    assert status["a2"] == ("dropped", "The close-out plan only lowers prices")
    assert status["a3"][0] == "proposed" and actions["a3"]["after"] == "$1.75"
    assert status["a4"] == ("dropped", "Only one change of this kind per item")
    assert status["a5"][0] == "dropped" and "never lists stock the shop didn't count" in status["a5"][1]
    assert status["a6"] == ("dropped", "Can't go below 3 held or paid unit(s)")
    assert status["a7"] == ("dropped", "Has 2 booking(s)")  # the paid order and the hold
    assert status["a8"] == ("dropped", "Can't go below its 2 booking(s)")
    assert status["a9"][0] == "proposed"
    assert status["a10"] == ("dropped", "No such product")


def test_only_a_manager_can_apply_and_staff_see_it_read_only(manager, staff):
    at(18, 5)
    closeout.run_due()
    seen = ok(staff.get("/api/merchant/closeout"))
    assert seen["plan"] and seen["can_apply"] is False
    assert staff.post(f"/api/merchant/closeout/{seen['plan']['id']}/apply", json={}).status_code == 403
    assert staff.post("/api/merchant/closeout/run").status_code == 403
    assert ok(manager.get("/api/merchant/closeout"))["can_apply"] is True


def test_applying_a_price_cut_is_exactly_the_manual_change(client, manager, fixture_llm):
    at(18, 5)
    open_quote = quote_lines(client, [("BR-02", 2)])  # not held: must ask the shopper to approve the new price
    held_quote = quote_lines(client, [("SC-04", 1)])
    reserve(client, held_quote["id"])  # held: keeps its price
    fixture_llm.queue(TASK, read_all(), plan_with({"type": "lower_price", "sku": "BR-02", "new_price_dollars": 1.75, "reason": "slow"},
                                                  {"type": "lower_price", "sku": "SC-04", "new_price_dollars": 2.25, "reason": "slow"}))
    plan = ok(manager.post("/api/merchant/closeout/run"))
    applied = ok(manager.post(f"/api/merchant/closeout/{plan['id']}/apply", json={}))

    assert applied["status"] == "applied" and {a["status"] for a in applied["actions"]} == {"applied"}
    assert any(p["kind"] == "price_changed" for p in ok(client.get(f"/api/quotes/{open_quote['id']}"))["validity"]["problems"])
    assert ok(client.get(f"/api/quotes/{held_quote['id']}"))["validity"]["valid"] is True
    with transaction() as db:
        price = db.scalars(select(Price).where(Price.sku == "BR-02").order_by(Price.effective_at.desc())).first()
        assert (price.sale_minor, price.reference_minor) == (175, 300)  # reference untouched
        assert price.created_by.startswith("staff:")  # made as the approving manager
        record = db.scalars(select(AuditEvent).where(AuditEvent.action == "closeout_applied")).one()
        alert = db.scalars(select(MerchantAlert).where(MerchantAlert.entity_id == plan["id"])).one()
    assert record.actor == "agent:closeout" and record.meta["approved_by"].startswith("staff:")
    assert record.meta["agent_run_id"] == plan["run_id"] and record.meta["applied"] == ["a1", "a2"]
    assert alert.resolved_at is not None


def test_a_product_changed_after_the_plan_is_skipped_not_overwritten(client, manager, staff, fixture_llm):
    at(18, 5)
    fixture_llm.queue(TASK, read_all(), plan_with({"type": "lower_price", "sku": "CR-01", "new_price_dollars": 2.0, "reason": "slow"},
                                                  {"type": "lower_price", "sku": "CC-10", "new_price_dollars": 1.25, "reason": "slow"}))
    plan = ok(manager.post("/api/merchant/closeout/run"))
    counter_sale(staff, "CR-01", 3)  # staff sold some at the counter meanwhile
    applied = by_id(ok(manager.post(f"/api/merchant/closeout/{plan['id']}/apply", json={})))
    assert applied["a1"]["status"] == "skipped" and applied["a1"]["note"] == "Changed since the plan was made"
    assert applied["a2"]["status"] == "applied"
    with transaction() as db:
        assert db.scalars(select(Price).where(Price.sku == "CR-01").order_by(Price.effective_at.desc())).first().sale_minor == 250


def test_a_plan_can_be_applied_in_parts_or_dismissed(manager, fixture_llm):
    at(18, 5)
    fixture_llm.queue(TASK, read_all(), plan_with({"type": "lower_price", "sku": "CR-01", "new_price_dollars": 2.0, "reason": "slow"},
                                                  {"type": "pause_listing", "sku": "RY-13", "reason": "won't sell"}))
    plan = ok(manager.post("/api/merchant/closeout/run"))
    part = ok(manager.post(f"/api/merchant/closeout/{plan['id']}/apply", json={"action_ids": ["a2"]}))
    assert part["status"] == "partly_applied" and by_id(part)["a1"]["status"] == "proposed"
    with transaction() as db:
        assert db.get(Product, product_id("RY-13")).status == "paused"
    gone = ok(manager.post(f"/api/merchant/closeout/{plan['id']}/dismiss"))
    assert gone["status"] == "dismissed"
    assert manager.post(f"/api/merchant/closeout/{plan['id']}/apply", json={}).status_code == 409


def test_run_now_replaces_an_undecided_plan(manager):
    first = ok(manager.post("/api/merchant/closeout/run"))
    second = ok(manager.post("/api/merchant/closeout/run"))
    with transaction() as db:
        assert db.get(AgentProposal, first["id"]).status == "superseded"
    assert ok(manager.get("/api/merchant/closeout"))["plan"]["id"] == second["id"]


def test_no_plan_is_made_after_pickup_ends(manager):
    at(19, 5)  # pickup ended at 7:00 PM
    res = manager.post("/api/merchant/closeout/run")
    assert res.status_code == 422 and res.json()["error"]["code"] == "pickup_ended"
    assert ok(manager.get("/api/merchant/closeout"))["plan"] is None


def test_plans_expire_when_pickup_ends(manager):
    at(18, 5)
    closeout.run_due()
    plan = ok(manager.get("/api/merchant/closeout"))["plan"]
    at(19, 1)
    closeout.run_due()
    assert plan_row().status == "expired"
    assert manager.post(f"/api/merchant/closeout/{plan['id']}/apply", json={}).status_code == 409


def test_turning_the_assistant_off_stops_the_daily_plan(manager):
    ok(manager.patch("/api/merchant/shop/policies", json={"closeout_enabled": False, "closeout_lead_minutes": 90}))
    at(18, 5)
    assert closeout.run_due()["started"] == 0
    schedule = ok(manager.get("/api/merchant/closeout"))["schedule"]
    assert schedule["enabled"] is False and schedule["runs_at_label"] == "5:30 PM"
    assert manager.patch("/api/merchant/shop/policies", json={"closeout_lead_minutes": 5}).status_code == 422
    assert manager.patch("/api/merchant/shop/policies", json={"closeout_enabled": "yes"}).status_code == 422


def test_a_shop_open_around_the_clock_closes_out_at_the_end_of_the_day():
    seed_bakery(slug="night-owl", name="Night Owl Doughnuts", catalog=NIGHT_OWL_CATALOG, window=("00:00", "23:59"))
    at(22, 30)
    closeout.run_due()
    with transaction() as db:
        night_owl = db.scalars(select(AgentProposal).where(AgentProposal.merchant_id == shop_id("night-owl"))).all()
    assert night_owl == []
    at(23, 5)
    closeout.run_due()
    with transaction() as db:
        plan = db.scalars(select(AgentProposal).where(AgentProposal.merchant_id == shop_id("night-owl"))).one()
    assert clock.display_time(plan.expires_at, "America/Los_Angeles") == "11:59 PM"


def test_the_agent_reads_through_tools_and_its_run_is_recorded(manager, fixture_llm):
    at(18, 5)
    fixture_llm.queue(TASK, read_all(), plan_with(summary="Nothing to change; it's selling well."))
    plan = ok(manager.post("/api/merchant/closeout/run"))
    assert plan["status"] == "applied" and plan["actions"] == [] and plan["source"] == "agent"
    stock = json.loads(next(m["content"] for m in fixture_llm.calls[1]["messages"] if m["role"] == "tool"))
    croissant = next(p for p in stock["products"] if p["sku"] == "CR-01")
    assert croissant["lowest_allowed_price"] == "$1.20" and croissant["price_changed_today"] is False
    assert stock["minutes_left"] == 55
    with transaction() as db:
        run = db.get(AgentRun, plan["run_id"])
        tools = [s.tool for s in db.scalars(select(AgentStep).where(AgentStep.run_id == run.id).order_by(AgentStep.idx))]
    assert (run.kind, run.status) == ("closeout", "done")
    assert {c["think"] for c in fixture_llm.calls} == {"low"}  # keeps Run now quick
    assert tools == ["get_stock", "get_pickup_slots", "get_today_sales", "propose_plan"]


def test_with_the_model_off_the_rules_plan_skips_items_that_are_selling(client, manager):
    ai_provider.set_provider(None)
    buy(client, [("BR-02", 6)], slot_index=1)  # 6 of 10 rolls sold
    at(18, 5)
    plan = ok(manager.post("/api/merchant/closeout/run"))
    skus = {a["sku"] for a in plan["actions"]}
    assert plan["source"] == "rules" and "BR-02" not in skus and "CC-10" in skus
