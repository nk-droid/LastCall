"""The shop's AI teammates page: Ask LastCall's suggestions and passes, close-out plans and watch alerts for one shop.

Shops see shoppers' requests only as structured facts, never their words; a shop can opt out of Ask LastCall."""

from __future__ import annotations

import json
from collections import Counter
from datetime import timedelta

import pytest

from app import clock
from app.db import transaction
from app.ids import new_id
from app.models import Watch, WatchMatch
from app.seed.catalogs import NIGHT_OWL_CATALOG

from .conftest import new_client
from .factories import member_client, signup
from .fixtures import seed_bakery
from .helpers import ok, shop_id

pytestmark = pytest.mark.usefixtures("bakery")
TASK = "concierge"


@pytest.fixture
def night_owl() -> str:
    return seed_bakery(slug="night-owl", name="Night Owl Doughnuts", catalog=NIGHT_OWL_CATALOG)


def call(name: str, **args) -> dict:
    return {"name": name, "args": args}


def turn(*calls: dict) -> dict:
    return {"tool_calls": list(calls)}


def first_option(messages: list[dict]) -> dict:
    results = [json.loads(m["content"]) for m in messages if m["role"] == "tool"]
    picks = [r["options"][0]["option_id"] for r in results if r.get("options")]
    return turn(call("respond", message="This one fits.", option_ids=picks[:1]))


def ask(client, text: str) -> dict:
    started = ok(client.post("/api/concierge/messages", json={"text": text}))
    return ok(client.get(f"/api/concierge/{started['id']}"))


def activity(member) -> dict:
    return ok(member.get("/api/merchant/assistant"))


def test_each_shop_sees_what_ask_lastcall_did_for_it_as_facts(app, client, fixture_llm, night_owl):
    # Juniper's bundle is shown; Night Owl can't feed 30 people for $10, so it is passed on.
    fixture_llm.queue(TASK, turn(call("find_bundles", shop="juniper-rye", party_size=4, budget_dollars=10),
                                 call("find_bundles", shop="night-owl", party_size=30, budget_dollars=10)), first_option)
    reply = ask(client, "Snacks for 4 people under $10, my daughter is allergic to peanuts")["messages"][-1]
    card = reply["cards"][0]
    assert card["shop"]["slug"] == "juniper-rye"

    juniper = activity(member_client(app, shop_id(), "staff")[0])
    owl = activity(member_client(app, night_owl, "staff")[0])

    [suggested] = juniper["feed"]
    assert suggested["title"] == "Ask LastCall suggested your bundle" and suggested["status"] is None
    assert suggested["detail"].startswith("4 people · under $10.00 · no peanuts · ")
    assert "pickup" not in suggested["detail"]  # no time was asked for, so the shop's whole window isn't shown as one
    assert juniper["teammates"]["concierge"] == {"listed": True, "suggested_today": 1, "suggested_week": 1, "ordered_week": 0}
    assert juniper["gaps"] == []

    [passed] = owl["feed"]
    assert passed["title"] == "Ask LastCall passed on your shop" and passed["detail"].startswith("30 people · under $10.00 · no peanuts")
    assert [g["count"] for g in owl["gaps"]] == [1]
    # The shopper's own words never reach the shop.
    for view in (juniper, owl):
        assert "daughter" not in json.dumps(view) and "allergic" not in json.dumps(view)

    # Opening the bundle is reflected on the shop's feed.
    ok(client.post("/api/quotes", json={"proposal_id": card["proposal_id"], "option_id": card["option_key"], "pickup_slot_id": card["default_slot_id"]}))
    assert activity(member_client(app, shop_id(), "staff")[0])["feed"][0]["status"] == {"tone": "info", "label": "Opened"}


def test_a_shop_can_opt_out_of_ask_lastcall(app, client, fixture_llm, night_owl):
    manager = member_client(app, night_owl, "manager")[0]
    staff = member_client(app, night_owl, "staff")[0]
    assert staff.patch("/api/merchant/shop/policies", json={"concierge_listed": False}).status_code == 403
    assert manager.patch("/api/merchant/shop/policies", json={"concierge_listed": "no"}).status_code == 422
    ok(manager.patch("/api/merchant/shop/policies", json={"concierge_listed": False}))
    assert activity(staff)["teammates"]["concierge"]["listed"] is False

    fixture_llm.queue(TASK, turn(call("list_shops"), call("find_bundles", shop="night-owl", party_size=2)),
                      turn(call("respond", message="", questions=["Anything else?"])))
    ask(client, "Breakfast for 2 people")
    results = [json.loads(m["content"]) for m in fixture_llm.calls[-1]["messages"] if m["role"] == "tool"]
    assert [s["shop"] for s in results[0]["shops"]] == ["juniper-rye"]
    assert "no open shop" in results[1]["error"]
    assert activity(staff)["feed"] == []

    # The shop's own storefront chat still works.
    fixture_llm.queue(TASK, turn(call("find_bundles", shop="night-owl", party_size=2)), first_option)
    started = ok(client.post("/api/concierge/messages", json={"text": "Breakfast for 2 people", "shop": "night-owl"}))
    assert ok(client.get(f"/api/concierge/{started['id']}"))["messages"][-1]["cards"]


def test_a_busy_assistant_cannot_push_the_others_out_of_the_feed():
    from app.services.assistant import FEED_PER_ASSISTANT, _per_assistant
    feed = ([{"kind": "concierge"}] * 20 + [{"kind": "concierge_skip"}] * 5 + [{"kind": "watch"}] * 2 + [{"kind": "closeout"}] * 3)
    kinds = Counter(i["kind"] for i in _per_assistant(feed))
    assert kinds["concierge"] + kinds["concierge_skip"] == FEED_PER_ASSISTANT
    assert kinds["watch"] == 2 and kinds["closeout"] == 3


def test_close_out_plans_and_watch_alerts_join_the_feed(app):
    manager = member_client(app, shop_id(), "manager")[0]
    clock.advance(timedelta(hours=3, minutes=5))  # 6:05 PM, an hour before pickup ends: the rules plan (model off)
    plan = ok(manager.post("/api/merchant/closeout/run"))
    assert plan["status"] == "pending"

    clock.advance(timedelta(minutes=1))  # the alert goes out a minute later
    shopper = new_client(app)
    user = signup(shopper, "watcher@example.com")["user"]
    with transaction() as db:
        watch = Watch(id=new_id("wch"), user_id=user["id"], merchant_id=None, text_redacted="croissants for me under $8",
                      constraints={"party_size": 1, "budget_minor": 800, "exclusions": [], "dietary": [], "preferences": ["pastries"]},
                      status="active", stop_token=new_id("tok"), expires_at=clock.now() + timedelta(days=7))
        db.add(watch)
        db.flush()
        db.add(WatchMatch(id=new_id("wmt"), watch_id=watch.id, merchant_id=shop_id(), signature="CR-01:1", label="Bakery classics", summary="",
                          total_minor=600, currency="USD", pickup_label="Today 6:30–7:00 PM", email_message_id=new_id("eml"), created_at=clock.now()))
        db.add(WatchMatch(id=new_id("wmt"), watch_id=watch.id, merchant_id=shop_id(), signature="BR-02:1", label="Not picked", summary="",
                          summary_source="skipped", total_minor=500, currency="USD", pickup_label="", created_at=clock.now()))  # judged, never sent

    view = activity(manager)
    kinds = [(i["kind"], i["title"]) for i in view["feed"]]
    assert kinds == [("watch", "Watch alert sent"), ("closeout", "Close-out drafted a plan")]
    alert, drafted = view["feed"]
    assert alert["detail"] == "A shopper watching for 1 person, under $8.00 got “Bakery classics” for $6.00"
    assert alert["status"] == {"tone": "neutral", "label": "Not opened"} and "croissants" not in json.dumps(view)
    assert drafted["action"] == "review" and drafted["status"]["label"] == "Waiting for your OK" and "price cut" in drafted["detail"]
    assert drafted["day"] == view["today"] and drafted["time_label"] == "6:05 PM"
    assert view["teammates"]["closeout"]["waiting"] is True
    assert view["teammates"]["watch"] == {"alerts_today": 1, "alerts_week": 1, "watching": 1, "opened_week": 0, "ordered_week": 0}
    assert view["can_edit"] is True

    ok(manager.post(f"/api/merchant/closeout/{plan['id']}/dismiss"))
    drafted = next(i for i in activity(manager)["feed"] if i["kind"] == "closeout")
    assert drafted["action"] is None and drafted["status"] == {"tone": "neutral", "label": "Dismissed"}
