"""Bundle engine acceptance tests (AT-01..05, 13, 14) plus holds, price changes and one-shop baskets."""

from __future__ import annotations

import threading
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app import clock
from app.ai.provider import ProviderFailure
from app.db import transaction
from app.models import AIInvocation, AnalyticsEvent, Price, Reservation
from app.services import holds

from .conftest import new_client
from .factories import member_client
from .fixtures import seed_bakery
from .helpers import STRICT_NO_NUTS, available, bookable_slot, ok, parse, propose, quote_lines, reserve, sell_out, shop_id

pytestmark = pytest.mark.usefixtures("bakery")

NUT_RISK = {"AC-06", "BB-11", "CB-07", "MU-03"}
BAGEL = [dict(sku="BG-01", name="Everything bagel", category="bread", flavor="savory", servings=1, tags=["handheld", "breakfast"], surplus=10,
              reference=300, sale=175, contains=["wheat", "sesame"], cross=[], status="verified", cutoff_offset=0, priority=1,
              dietary={"vegetarian": True, "vegan": True}, ingredients="Wheat flour, water, malt, yeast, salt, sesame",
              description="Boiled, then baked with an everything-seed crust.")]


def _staff(app):
    return member_client(app, shop_id(), "staff")[0]


def _row(member, sku: str) -> dict:
    return next(r for r in ok(member.get("/api/merchant/inventory"))["rows"] if r["sku"] == sku)


# --------------------------------------------------------------------------- AT-01 / AT-02


def test_at01_four_people_under_18_no_nuts_only_eligible_bundles(client):
    result = propose(client, "snacks for 4 people under $18, no nuts")
    assert result["options"], result["no_match"]
    for option in result["options"]:
        skus = {line["sku"] for line in option["lines"]}
        assert option["totals"]["total_minor"] <= 1800
        assert not skus & NUT_RISK
        assert option["units"] >= 4
        assert option["pickup_slots"], "every option must have a bookable pickup slot"
    excluded = {e["sku"]: e["reasons"] for e in result["excluded"]}
    assert NUT_RISK <= set(excluded)
    assert any("not merchant-verified" in r for r in excluded["MU-03"])
    assert any("cross-contact" in r for r in excluded["CB-07"])
    assert result["options"][0]["label"].startswith("Best fit")


def test_at01_impossible_budget_returns_explicit_no_match(client):
    result = propose(client, "snacks for 4 people under $3, no nuts")
    assert result["options"] == []
    assert "budget" in result["no_match"]["headline"].lower()
    assert any(s["action"] == "set_budget" and s["value"] > 300 for s in result["no_match"]["suggestions"])


def test_at01_budget_pick_is_cheapest_feasible_bundle(client):
    result = propose(client)
    totals = [o["totals"]["total_minor"] for o in result["options"]]
    budget = next((o for o in result["options"] if o["kind"] == "budget_pick"), result["options"][0])
    assert budget["totals"]["total_minor"] == min(totals)


def test_at02_model_proposed_unavailable_sku_is_rejected(client, fixture_llm):
    fixture_llm.queue("L2_bundle", {
        "rationales": [],
        "candidates": [
            {"items": [{"sku": "ZZ-99", "qty": 2}, {"sku": "CR-01", "qty": 2}], "rationale": "invented item"},
            {"items": [{"sku": "MU-03", "qty": 4}], "rationale": "unverified allergen data"},
            {"items": [{"sku": "FT-05", "qty": 5}], "rationale": "more than in stock"},
        ],
        "questions": [],
    })
    result = propose(client)
    skus = {line["sku"] for o in result["options"] for line in o["lines"]}
    assert "ZZ-99" not in skus and "MU-03" not in skus
    for option in result["options"]:
        for line in option["lines"]:
            assert line["qty"] <= line["available"]
    assert result["ai"]["used"] is True
    assert result["ai"]["rejected_candidates"] == 3 and result["ai"]["accepted_candidates"] == 0
    with transaction() as db:
        inv = db.scalar(select(AIInvocation).where(AIInvocation.task == "L2_bundle").order_by(AIInvocation.created_at.desc()))
        assert inv.validation_result == "valid_with_rejections" and "ZZ-99" in (inv.failure_reason or "")
    r = client.post("/api/quotes", json={"lines": [{"sku": "ZZ-99", "qty": 1}], "pickup_slot_id": bookable_slot(client), "merchant": "juniper-rye"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "quote_invalid"


# --------------------------------------------------------------------------- AT-03 concurrency


def _race(app, sku: str, buyers_count: int) -> list[str]:
    buyers = [new_client(app) for _ in range(buyers_count)]
    quotes = [quote_lines(b, [(sku, 1)]) for b in buyers]
    barrier = threading.Barrier(len(buyers))
    outcomes: list[str] = []
    lock = threading.Lock()

    def attempt(buyer, quote) -> None:
        sid = buyer.cookies.get("lc_sid")
        barrier.wait()
        try:
            holds.reserve_for_session(sid, quote["id"])
            result = "held"
        except Exception as exc:  # noqa: BLE001
            result = type(exc).__name__
        with lock:
            outcomes.append(result)

    threads = [threading.Thread(target=attempt, args=(b, q)) for b, q in zip(buyers, quotes, strict=True)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return outcomes


def test_at03_simultaneous_buyers_for_last_unit_only_one_reserves(app):
    sell_out(_staff(app), "FT-05", leave=1)
    outcomes = _race(app, "FT-05", 6)
    assert outcomes.count("held") == 1, outcomes
    assert all(o == "QuoteInvalid" for o in outcomes if o != "held"), outcomes
    assert available("FT-05") == 0
    with transaction() as db:
        assert db.scalar(select(func.count()).select_from(Reservation).where(Reservation.state == "HELD")) == 1


def test_at03_many_buyers_never_oversell(app):
    sell_out(_staff(app), "SF-12", leave=2)
    assert _race(app, "SF-12", 8).count("held") == 2
    assert available("SF-12") == 0


# --------------------------------------------------------------------------- AT-04 / AT-05


def test_at04_inventory_change_invalidates_quote_and_requires_new_approval(client, app):
    parsed = parse(client, "snacks for 4 people under $18, no nuts", STRICT_NO_NUTS)
    quote = quote_lines(client, [("CR-01", 2), ("FT-05", 1), ("BR-02", 2)], intent_id=parsed["intent_id"])
    sell_out(_staff(app), "FT-05")

    status = ok(client.get(f"/api/quotes/{quote['id']}"))
    assert status["validity"]["valid"] is False
    assert any(p["kind"] == "sold_out" and p["sku"] == "FT-05" for p in status["validity"]["problems"])

    r = client.post("/api/reservations", json={"quote_id": quote["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "quote_invalid"
    offer = r.json()["error"]["details"]["offer"]
    assert offer["state"] == "OFFERED"
    assert [x["sku"] for x in offer["comparison"]["removed"]] == ["FT-05"]
    assert offer["comparison"]["before"]["total_minor"] == quote["totals"]["total_minor"]
    proposed_id = offer["proposed_quote_id"]

    # Nothing changes without explicit acceptance: the proposed basket can't be held yet.
    assert client.post("/api/reservations", json={"quote_id": proposed_id}).json()["error"]["code"] == "offer_pending"
    accepted = ok(client.post(f"/api/substitutions/{offer['id']}/accept"))
    assert accepted["id"] == proposed_id and accepted["status"] == "ACTIVE"
    assert ok(client.get(f"/api/quotes/{quote['id']}"))["status"] == "SUPERSEDED"
    held = reserve(client, proposed_id)
    assert held["reservation"]["state"] == "HELD" and held["quote"]["totals"]["total_minor"] == accepted["totals"]["total_minor"]


def test_at05_strict_allergy_missing_evidence_is_excluded_without_unsafe_substitution(client, app):
    parsed = parse(client, "4 people, my son has a nut allergy", None)
    assert all(e["severity"] == "strict" for e in parsed["intent"]["exclusions"]), parsed["intent"]
    result = ok(client.post("/api/bundles/propose", json={"intent_id": parsed["intent_id"]}))
    assert "MU-03" in {e["sku"] for e in result["excluded"]}
    assert not {line["sku"] for o in result["options"] for line in o["lines"]} & NUT_RISK

    quote = quote_lines(client, [("FT-05", 2), ("CR-01", 2)], intent_id=parsed["intent_id"])
    sell_out(_staff(app), "FT-05")
    offer = ok(client.post(f"/api/bundles/{quote['id']}/substitute", json={}))
    added = {a["sku"] for a in offer["comparison"]["added"]}
    alternatives = {a["add_sku"] for a in offer["alternatives"] if a["add_sku"]}
    assert not (added | alternatives) & NUT_RISK
    blocked = client.post("/api/quotes", json={"lines": [{"sku": "MU-03", "qty": 4}], "pickup_slot_id": quote["pickup"]["id"],
                                               "intent_id": parsed["intent_id"], "merchant": "juniper-rye"})
    assert blocked.status_code == 409
    assert any(p["kind"] == "dietary" for p in blocked.json()["error"]["details"]["problems"])


# --------------------------------------------------------------------------- AT-13 / AT-14


def test_at13_model_timeout_falls_back_to_rules(client, fixture_llm):
    fixture_llm.queue("L1_intent", ProviderFailure("timeout", "model call timed out"))
    parsed = parse(client, "snacks for 4 people under $18")
    assert parsed["parser"] == "rules" and parsed["ai"]["fallback_reason"] == "timeout"
    assert parsed["intent"]["party_size"] == 4 and parsed["intent"]["budget_minor"] == 1800
    with transaction() as db:
        inv = db.scalar(select(AIInvocation).where(AIInvocation.task == "L1_intent"))
        assert inv.validation_result == "timeout" and inv.fallback_used


def test_at14_savings_and_stock_claims_trace_to_merchant_data(client, fixture_llm):
    fixture_llm.queue("L2_bundle", {"rationales": [{"option_id": "opt-1", "rationale": "Hurry, only 2 left! These are nut-free and totally safe. A good sweet and savory spread."}],
                                     "candidates": [], "questions": []})
    result = propose(client)
    with transaction() as db:
        prices = {p.sku: p for p in db.scalars(select(Price)).all()}
    for option in result["options"]:
        reference = sale = 0
        for line in option["lines"]:
            assert line["unit_reference_minor"] == prices[line["sku"]].reference_minor
            assert line["unit_sale_minor"] == prices[line["sku"]].sale_minor
            assert line["stock_limited"] == (line["qty"] >= available(line["sku"]))
            reference += line["line_reference_minor"]
            sale += line["line_total_minor"]
        assert option["totals"]["discount_minor"] == reference - sale
    rationale = result["options"][0]["rationale"]
    assert rationale["source"] == "ai"
    lowered = rationale["text"].lower()
    for banned in ("hurry", "only 2 left", "nut-free", "safe"):
        assert banned not in lowered
    assert "sweet and savory" in lowered


# --------------------------------------------------------------------------- holds, prices, shops


def test_held_stock_cannot_be_silently_removed(client, app):
    quote = quote_lines(client, [("FT-05", 2)])
    reserve(client, quote["id"])
    staff = _staff(app)
    row = _row(staff, "FT-05")
    assert row["reserved"] == 2 and row["available"] == 0
    r = staff.post("/api/merchant/inventory", json={"product_id": row["product_id"], "action": "set", "value": 1, "expected_version": row["version"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "held_stock"


def test_price_change_after_quote_requires_customer_approval(client, app):
    quote = quote_lines(client, [("BR-02", 2)])
    manager = member_client(app, shop_id(), "manager")[0]
    row = _row(manager, "BR-02")
    ok(manager.post(f"/api/merchant/products/{row['product_id']}/price", json={"reference_minor": 300, "sale_minor": 175, "reference_source": "menu board"}))
    status = ok(client.get(f"/api/quotes/{quote['id']}"))
    assert any(p["kind"] == "price_changed" for p in status["validity"]["problems"])
    offer = ok(client.post(f"/api/bundles/{quote['id']}/substitute", json={}))
    assert offer["trigger"] == "price_change" and offer["comparison"]["after"]["total_minor"] == 350


def test_expired_hold_is_released_by_the_sweeper(client):
    quote = quote_lines(client, [("FT-05", 2)])
    reserve(client, quote["id"])
    clock.advance(timedelta(minutes=11))
    assert holds.sweep_expired()["released"] == 1
    with transaction() as db:
        res = db.scalar(select(Reservation).where(Reservation.quote_id == quote["id"]))
        assert res.state == "RELEASED" and res.released_reason == "expired"
        assert db.scalar(select(func.count()).select_from(AnalyticsEvent).where(AnalyticsEvent.event_name == "reservation_expired")) == 1
    assert available("FT-05") == 2


def test_bundles_only_use_the_chosen_shops_products(client):
    seed_bakery(slug="bagel-corner", name="Bagel Corner", catalog=BAGEL)
    parsed = parse(client, "breakfast for 4 people under $10", merchant="bagel-corner", use_ai=False)
    proposal = ok(client.post("/api/bundles/propose", json={"intent_id": parsed["intent_id"]}))
    assert proposal["merchant"]["slug"] == "bagel-corner"
    used = {line["sku"] for option in proposal["options"] for line in option["lines"]}
    assert used == {"BG-01"}
    quote = ok(client.post("/api/quotes", json={"proposal_id": proposal["proposal_id"], "option_id": proposal["options"][0]["id"]}))
    assert quote["merchant"]["slug"] == "bagel-corner"


def test_a_basket_cannot_mix_shops(client):
    seed_bakery(slug="bagel-corner", name="Bagel Corner", catalog=BAGEL)
    bagel_slot = bookable_slot(client, "bagel-corner")
    assert client.post("/api/quotes", json={"lines": [{"sku": "CR-01", "qty": 1}], "pickup_slot_id": bagel_slot, "merchant": "bagel-corner"}).status_code in (404, 409, 422)
    assert client.post("/api/quotes", json={"lines": [{"sku": "BG-01", "qty": 1}], "pickup_slot_id": bagel_slot, "merchant": "juniper-rye"}).status_code in (404, 409)
    assert quote_lines(client, [("BG-01", 2)], merchant="bagel-corner")["merchant"]["name"] == "Bagel Corner"


def test_unlisted_shops_take_no_baskets(client):
    seed_bakery(slug="not-yet", name="Not Yet Bakery", status="pending_review")
    r = client.post("/api/intents/parse", json={"text": "snacks for 2", "merchant": "not-yet"})
    assert r.status_code == 404
