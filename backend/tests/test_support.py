"""Support reply drafts: a template at once, then an agent that checks money questions with PayPal (as the shop that was paid)."""

from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from app.db import transaction
from app.models import AgentRun, AgentStep
from app.payments.base import PayPalOutcomeUnknown

from .factories import member_client
from .helpers import buy, drain_jobs, ok, shop_id

pytestmark = pytest.mark.usefixtures("bakery")

TASK = "support"


def call(name: str, **args) -> dict:
    return {"tool_calls": [{"name": name, "args": args}]}


def _owner(app):
    owner = member_client(app, shop_id(), "owner")[0]
    ok(owner.put("/api/merchant/shop/payouts", json={"merchant_id": "JUNIPERRYE001"}))  # the shop is paid directly
    return owner


def _ask(client, owner, order_id: str, text: str) -> dict:
    ok(client.post(f"/api/orders/{order_id}/support", json={"message": text}))
    template = ok(owner.get(f"/api/merchant/orders/{order_id}"))["support"][-1]
    assert template["ai_draft_source"] == "rules" and template["ai_draft"]  # staff can answer before the agent finishes
    drain_jobs()
    return ok(owner.get(f"/api/merchant/orders/{order_id}"))["support"][-1]


def test_a_refund_question_is_answered_from_what_paypal_reports(client, app, fixture_llm, paypal):
    owner = _owner(app)
    co, _ = buy(client, [("CR-01", 2)])
    paypal.refund_pending = True
    ok(owner.post(f"/api/merchant/orders/{co['order_id']}/refund", json={"reason": "Ran out before pickup"}))
    fixture_llm.queue(TASK, call("check_payment_with_paypal"),
                      call("draft_reply", reply="Your refund of $5.00 is on its way back to your PayPal account. It can take a few days to show up."))

    support = _ask(client, owner, co["order_id"], "I cancelled, where is my money?")

    assert support["ai_draft_source"] == "agent" and support["ai_draft"].startswith("Your refund of $5.00 is on its way")
    labels = [(c["label"], c["value"].split(" · ")[:2]) for c in support["ai_checks"]]
    assert labels == [("Payment", ["Refunded", "$5.00"]), ("Refund", ["On its way", "$5.00"])]  # what the shop's PayPal account shows
    seen = json.loads(next(m["content"] for m in fixture_llm.calls[1]["messages"] if m["role"] == "tool"))
    assert seen["refunds"][0]["status"] == "PENDING" and seen["capture"]["amount"] == "$5.00"
    with transaction() as db:
        run = db.get(AgentRun, support["ai_run_id"])
        tools = [s.tool for s in db.scalars(select(AgentStep).where(AgentStep.run_id == run.id).order_by(AgentStep.idx)).all()]
    assert (run.kind, run.status, tools) == ("support", "done", ["check_payment_with_paypal", "draft_reply"])


def test_a_question_that_isnt_about_money_is_answered_without_paypal(client, app, fixture_llm):
    owner = _owner(app)
    co, _ = buy(client, [("CR-01", 1)])
    fixture_llm.queue(TASK, call("draft_reply", reply="Your order will be on the LastCall shelf by the register during your pickup window."))
    support = _ask(client, owner, co["order_id"], "Where do I pick up?")
    assert support["ai_draft_source"] == "agent" and support["ai_checks"] == []


def test_when_paypal_cant_be_reached_the_agent_still_drafts_without_live_payment_facts(client, app, fixture_llm, paypal, monkeypatch):
    owner = _owner(app)
    co, _ = buy(client, [("CR-01", 1)])

    def unreachable(*args, **kwargs):
        raise PayPalOutcomeUnknown("get_capture", "ConnectTimeout")

    monkeypatch.setattr(paypal, "get_capture", unreachable)
    fixture_llm.queue(TASK, call("check_payment_with_paypal"), call("draft_reply", reply="Thanks for checking in. We'll look into the charge and reply here."))
    support = _ask(client, owner, co["order_id"], "Was I charged twice?")
    assert support["ai_draft_source"] == "agent" and support["ai_checks"] == []
    tool_result = json.loads(next(m["content"] for m in fixture_llm.calls[1]["messages"] if m["role"] == "tool"))
    assert "couldn't be reached" in tool_result["error"]


def test_amounts_the_agent_was_not_shown_never_reach_the_draft(client, app, fixture_llm):
    owner = _owner(app)
    co, _ = buy(client, [("CR-01", 1)])
    fixture_llm.queue(TASK, call("draft_reply", reply="We'll refund you $40.00 today. Thanks for your patience."))
    support = _ask(client, owner, co["order_id"], "Can I get a refund?")
    assert support["ai_draft"] == "Thanks for your patience." and "$40" not in support["ai_draft"]


def test_without_a_model_the_template_draft_stays(client, app):
    owner = _owner(app)
    co, _ = buy(client, [("CR-01", 1)])
    support = _ask(client, owner, co["order_id"], "Where do I pick up?")
    assert support["ai_draft_source"] == "rules" and support["ai_draft"].startswith("Hi! Thanks for your message")
    with transaction() as db:
        assert db.get(AgentRun, support["ai_run_id"]).status == "fallback"


def test_ai_teammates_shows_what_the_support_agent_drafted(client, app, fixture_llm):
    owner = _owner(app)
    co, _ = buy(client, [("CR-01", 1)])
    fixture_llm.queue(TASK, call("check_payment_with_paypal"), call("draft_reply", reply="You were charged once: $2.50. Nothing else is pending."))
    support = _ask(client, owner, co["order_id"], "Was I charged twice?")
    ok(owner.post(f"/api/merchant/support/{support['id']}/reply", json={"reply": support["ai_draft"]}))
    activity = ok(owner.get("/api/merchant/assistant"))
    assert activity["teammates"]["support"] == {"drafted_today": 1, "drafted_week": 1, "checked_paypal_week": 1, "waiting": 0, "sent_as_drafted_week": 1}
    item = next(i for i in activity["feed"] if i["kind"] == "support")
    assert item["title"].startswith("Drafted a reply for LC-") and item["detail"] == "Checked with PayPal: Payment paid"
    assert item["status"] == {"tone": "success", "label": "Sent"}
