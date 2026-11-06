"""A2 Watch for me: standing requests checked whenever shops list surplus, at most one email a day, never twice per bundle.

Matching is the bundle engine's own (party size, budget, allergens, pickup time); the agent only decides
whether a code-approved bundle is what the shopper asked for and writes the email's one line."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import func, select, update

from app import clock
from app.ai import provider as ai_provider
from app.db import transaction
from app.models import AgentRun, EmailMessage, Job, Product, Reservation, Watch, WatchMatch
from app.services import watches

from .conftest import new_client
from .factories import member_client, signup
from .helpers import drain_jobs, ok, product_id, shop_id

pytestmark = pytest.mark.usefixtures("bakery")
EMAIL = "maya@example.com"
NUTS = {"tree_nuts", "peanuts"}


@pytest.fixture
def shopper(app):
    client = new_client(app)
    signup(client, EMAIL, name="Maya Rivera")
    return client


def watch(client, text: str, shop: str | None = "juniper-rye", **extra) -> dict:
    return ok(client.post("/api/me/watches", json={"text": text, **({"shop": shop} if shop else {}), **extra}))


def run_scans(seconds: int = 20) -> None:
    clock.advance(timedelta(seconds=seconds))
    drain_jobs()


def match_emails() -> list[EmailMessage]:
    with transaction() as db:
        rows = db.scalars(select(EmailMessage).where(EmailMessage.template == "watch_match").order_by(EmailMessage.created_at)).all()
        for r in rows:
            db.expunge(r)
        return list(rows)


def matched_products(match_id: str) -> set[str]:
    with transaction() as db:
        sig = db.get(WatchMatch, match_id).signature
        skus = [part.split(":")[0] for part in sig.split("|")]
        return {p.name for p in db.scalars(select(Product).where(Product.sku.in_(skus))).all()}


def test_a_signed_in_shopper_saves_a_watch_as_structured_fields(shopper):
    created = watch(shopper, "pastries for 4 under $15, nut allergy, pickup after 5")
    assert created["status"] == "active" and created["shop"] == {"slug": "juniper-rye", "name": "Juniper & Rye Bakehouse"}
    assert created["facts"][:2] == ["4 people", "under $15.00"]
    with transaction() as db:
        row = db.get(Watch, created["id"])
    assert row.constraints["party_size"] == 4 and row.constraints["budget_minor"] == 1500
    assert {e["code"] for e in row.constraints["exclusions"]} == NUTS
    assert row.constraints["pickup_window"] == ["17:00", "19:00"] and "pickup_date" not in row.constraints
    assert ok(shopper.get("/api/me/watches"))["watches"][0]["id"] == created["id"]


def test_guests_cannot_watch_and_a_party_size_is_required(client, shopper):
    assert client.post("/api/me/watches", json={"text": "croissants for 4"}).status_code == 401
    assert shopper.post("/api/me/watches", json={"text": "some croissants"}).status_code == 422


def test_a_shopper_can_watch_at_most_five_requests(shopper):
    for n in range(5):
        watch(shopper, f"snacks for {n + 2}")
    assert shopper.post("/api/me/watches", json={"text": "snacks for 9"}).status_code == 409


def test_a_fitting_bundle_sends_one_email_and_never_the_same_bundle_twice(shopper):
    created = watch(shopper, "breakfast for 2 under $10, nut allergy")
    run_scans()

    [email] = match_emails()
    assert email.to_email == EMAIL and email.subject.startswith("Found at Juniper & Rye Bakehouse")
    assert "/watches/stop/" in email.text_body and "breakfast for 2 under $10, nut allergy" in email.text_body
    with transaction() as db:
        match = db.scalars(select(WatchMatch).where(WatchMatch.watch_id == created["id"])).one()
        assert match.total_minor <= 1000 and match.email_message_id == email.id
        assert db.scalars(select(Reservation)).first() is None  # nothing held until the shopper opens it
    names = matched_products(match.id)
    with transaction() as db:
        for p in db.scalars(select(Product).where(Product.name.in_(names))).all():
            assert not NUTS & (set(p.allergens["contains"]) | set(p.allergens["cross_contact"])), p.name

    # Even once the daily quiet period is over, the same bundle is never sent again.
    with transaction() as db:
        db.execute(update(Watch).values(last_notified_at=None))
    run_scans()
    assert len(match_emails()) == 1


def test_at_most_one_email_per_watch_per_day(shopper):
    watch(shopper, "snacks for 3")
    run_scans()
    assert len(match_emails()) == 1
    watches.scan()  # a different bundle may fit now, but the watch was emailed less than a day ago
    assert len(match_emails()) == 1


def test_nothing_fitting_sends_nothing(shopper):
    watch(shopper, "dinner for 30 under $5")
    run_scans()
    assert match_emails() == []


def test_a_resumed_listing_triggers_a_scan_for_that_shop(app, shopper):
    staff = member_client(app, shop_id(), "manager")[0]
    with transaction() as db:
        products = db.scalars(select(Product)).all()
        skus = [p.sku for p in products]
    for sku in skus:
        ok(staff.post("/api/merchant/inventory", json={"product_id": product_id(sku), "action": "pause"}))
    watch(shopper, "snacks for 2")
    run_scans()
    assert match_emails() == []  # everything paused

    ok(staff.post("/api/merchant/inventory", json={"product_id": product_id("CR-01"), "action": "resume"}))
    with transaction() as db:
        job = db.scalars(select(Job).where(Job.kind == "watches.scan", Job.dedupe_key == f"watches.scan:{shop_id()}")).one()
        assert job.payload == {"merchant_id": shop_id()}
    run_scans()
    [email] = match_emails()
    assert "Butter croissant" in email.text_body


def test_paused_and_expired_watches_are_skipped(shopper):
    paused = watch(shopper, "snacks for 2")
    ok(shopper.patch(f"/api/me/watches/{paused['id']}", json={"status": "paused"}))
    expiring = watch(shopper, "snacks for 3")
    with transaction() as db:
        db.execute(update(Watch).where(Watch.id == expiring["id"]).values(expires_at=clock.now() - timedelta(minutes=1)))
    run_scans()
    assert match_emails() == []
    with transaction() as db:
        assert db.get(Watch, expiring["id"]).status == "expired"


def test_the_email_link_holds_through_the_normal_flow_in_any_browser(app, shopper):
    watch(shopper, "breakfast for 2 under $10")
    run_scans()
    with transaction() as db:
        match = db.scalars(select(WatchMatch)).one()
    phone = new_client(app)  # the email opened on another device, signed out
    opened = ok(phone.post(f"/api/watches/matches/{match.id}/open"))
    assert opened["status"] == "ready" and opened["changed"] is False
    quote = ok(phone.get(f"/api/quotes/{opened['quote_id']}"))
    assert quote["totals"]["total_minor"] == match.total_minor
    assert phone.post("/api/watches/matches/wmt_nope/open").status_code == 404


def test_a_sold_out_match_says_so_instead_of_inventing_a_bundle(app, shopper):
    staff = member_client(app, shop_id(), "manager")[0]
    watch(shopper, "breakfast for 2 under $10")
    run_scans()
    with transaction() as db:
        match = db.scalars(select(WatchMatch)).one()
        skus = [p.sku for p in db.scalars(select(Product)).all()]
    for sku in skus:
        ok(staff.post("/api/merchant/inventory", json={"product_id": product_id(sku), "action": "pause"}))
    assert ok(new_client(app).post(f"/api/watches/matches/{match.id}/open"))["status"] == "sold_out"


def test_the_stop_link_ends_the_watch(shopper, client):
    watch(shopper, "snacks for 2")
    run_scans()
    token = match_emails()[0].text_body.split("/watches/stop/")[1].split()[0]
    assert ok(client.post("/api/watches/stop", json={"token": token}))["stopped"] is True
    assert ok(shopper.get("/api/me/watches"))["watches"] == []


def test_the_agent_can_decline_a_bundle_that_is_not_what_was_asked(shopper, fixture_llm):
    fixture_llm.queue("L1_intent", {"party_size": 2})
    fixture_llm.queue("watch_match", {"tool_calls": [{"name": "notify", "args": {"send": False, "summary": "No croissants in this one."}}]})
    created = watch(shopper, "croissants for 2")
    run_scans()
    assert match_emails() == []
    with transaction() as db:
        match = db.scalars(select(WatchMatch).where(WatchMatch.watch_id == created["id"])).one()
        run = db.scalars(select(AgentRun).where(AgentRun.subject_id == created["id"])).one()
    assert match.summary_source == "skipped" and run.kind == "watch_match" and run.status == "done"


def test_the_agents_line_is_cleaned_before_it_is_emailed(shopper, fixture_llm):
    fixture_llm.queue("L1_intent", {"party_size": 2})
    fixture_llm.queue("watch_match", {"tool_calls": [{"name": "notify", "args": {
        "send": True, "summary": "Flaky croissants, just what you asked for. Totally nut-free and safe! Hurry, only 2 left!"}}]})
    watch(shopper, "croissants for 2")
    run_scans()
    [email] = match_emails()
    assert "Flaky croissants, just what you asked for." in email.text_body
    assert "nut-free" not in email.text_body.lower() and "Hurry" not in email.text_body


def test_with_the_model_off_matches_still_send_with_a_plain_line(shopper):
    ai_provider.set_provider(None)
    watch(shopper, "snacks for 2")
    run_scans()
    with transaction() as db:
        match = db.scalars(select(WatchMatch)).one()
        sent = db.scalar(select(func.count()).select_from(EmailMessage).where(EmailMessage.template == "watch_match"))
    assert sent == 1 and match.summary_source == "rules" and "at Juniper & Rye Bakehouse" in match.summary


def test_a_concierge_conversation_can_be_watched(shopper, fixture_llm):
    fixture_llm.queue("concierge", {"tool_calls": [{"name": "respond", "args": {"message": "", "questions": ["When would you like pickup?"]}}]})
    convo = ok(shopper.post("/api/concierge/messages", json={"text": "Savory snacks for 3 people under $14", "shop": "juniper-rye"}))
    fixture_llm.queue("L1_intent", {"party_size": 3, "budget_minor": 1400})
    created = watch(shopper, "", shop=None, conversation_id=convo["id"])
    assert created["request"] == "Savory snacks for 3 people under $14"
    assert created["shop"] == {"slug": "juniper-rye", "name": "Juniper & Rye Bakehouse"}
