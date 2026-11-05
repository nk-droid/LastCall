"""QuoteService: immutable, server-priced snapshots of a basket.

A quote records item lines, server-owned prices, discount, tax, fees, the pickup slot, an
eligibility snapshot (intent, dietary evidence, inventory as seen) and an expiry. Any change
to the basket produces a new quote version in the same lineage; the browser never supplies
a price.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.domain import Intent, check_dietary
from app.errors import Conflict, NotFound, QuoteInvalid, Unprocessable
from app.ids import new_id
from app.models import BundleProposal, BundleQuote, CustomerIntent, Merchant, PickupSlot, Reservation
from app.money import format_money
from app.services import analytics, audit, pickup
from app.services import reservations as rsv
from app.services.catalog import CatalogItem, allergen_view, catalog_items, get_merchant, image_view, merchant_by_id, merchant_ref, policy
from app.services.feasibility import ENGINE_VERSION, Problem, price_lines, validate_lines


def _tz_label(merchant: Merchant):
    return lambda dt: clock.display_time(dt, merchant.timezone)


def load_for_session(db: Session, quote_id: str, session_id: str, lock: bool = False) -> BundleQuote:
    query = select(BundleQuote).where(BundleQuote.id == quote_id)
    if lock:
        query = query.with_for_update()
    quote = db.scalar(query)
    if quote is None or quote.session_id != session_id:
        raise NotFound("Quote not found", code="quote_missing")
    return quote


def create_quote(
    db: Session,
    *,
    merchant: Merchant,
    session_id: str,
    lines: list[tuple[str, int]],
    intent: Intent | None,
    intent_id: str | None,
    slot_id: str,
    source: str,
    now: datetime,
    proposal_id: str | None = None,
    option_id: str | None = None,
    lineage_id: str | None = None,
    supersedes: BundleQuote | None = None,
    status: str = "ACTIVE",
    exclude_reservation_id: str | None = None,
    held_slot_id: str | None = None,
) -> BundleQuote:
    items = catalog_items(db, merchant, now, exclude_reservation_id=exclude_reservation_id)
    by_sku = {i.sku: i for i in items}
    slot = db.get(PickupSlot, slot_id)
    if slot is None or slot.merchant_id != merchant.id:
        raise NotFound("Pickup slot not found", code="slot_missing")
    ok, reason = pickup.slot_bookable(slot, merchant, now)
    if not ok and held_slot_id == slot.id and slot.booked_count >= slot.capacity:
        # The customer's own hold occupies this slot; re-quoting the same slot is fine.
        ok, reason = pickup.slot_bookable(slot, merchant, now, ignore_capacity=True)
    if not ok:
        raise Conflict(reason or "Pickup slot unavailable", code="slot_unavailable", details={"slot_id": slot_id})
    problems = validate_lines(
        lines, by_sku, intent,
        max_units=int(policy(merchant, "max_units_per_order", 12)),
        slot_ends_at=slot.ends_at, require_portions=False, tz_label=_tz_label(merchant),
    )
    if problems:
        raise QuoteInvalid("This basket can't be quoted as-is", details={"problems": [p.to_dict() for p in problems]})

    merged: dict[str, int] = {}
    for sku, qty in lines:
        merged[sku] = merged.get(sku, 0) + qty
    line_items: list[tuple[CatalogItem, int]] = [(by_sku[sku], qty) for sku, qty in sorted(merged.items())]
    totals = price_lines(line_items, dict(policy(merchant, "tax_rates_bps", {})), int(policy(merchant, "fees_minor", 0)))
    item_lines = []
    evidence: dict[str, Any] = {}
    for item, qty in line_items:
        item_lines.append({
            "sku": item.sku,
            "product_id": item.product_id,
            "price_id": item.price_id,
            "name": item.name,
            "qty": qty,
            "unit_sale_minor": item.sale_minor,
            "unit_reference_minor": item.reference_minor,
            "line_total_minor": item.sale_minor * qty,
            "line_reference_minor": item.reference_minor * qty,
            "tax_category": item.tax_category,
            "category": item.category,
            "flavor": item.flavor,
            "servings": item.servings,
            "reference_source": item.reference_source,
            "allergens": allergen_view(item.allergens, item.allergen_source),
            "image": image_view(item),
            "cutoff_at": clock.iso(item.cutoff_at),
        })
        if intent is not None:
            evidence[item.sku] = check_dietary(item.allergens, item.attributes, intent).evidence

    if lineage_id is None:
        lineage_id = new_id("bsk")
        version = 1
    else:
        version = (db.scalar(select(func.max(BundleQuote.quote_version)).where(BundleQuote.lineage_id == lineage_id)) or 0) + 1
    ttl = int(policy(merchant, "quote_ttl_seconds", 900))
    quote = BundleQuote(
        id=new_id("qt"),
        lineage_id=lineage_id,
        quote_version=version,
        supersedes_quote_id=supersedes.id if supersedes else None,
        merchant_id=merchant.id,
        session_id=session_id,
        intent_id=intent_id,
        proposal_id=proposal_id,
        option_id=option_id,
        source=source,
        item_lines=item_lines,
        currency=merchant.currency,
        subtotal_reference_minor=totals["reference_minor"],
        discount_minor=totals["discount_minor"],
        subtotal_minor=totals["subtotal_minor"],
        tax_minor=totals["tax_minor"],
        fees_minor=totals["fees_minor"],
        amount_minor=totals["total_minor"],
        pickup_slot_id=slot.id,
        pickup_slot_snapshot=pickup.snapshot(slot, merchant),
        eligibility_snapshot={
            "intent": intent.model_dump(mode="json") if intent else None,
            "dietary_evidence": evidence,
            "inventory": {item.sku: {"available": item.available, "lot_updated_at": clock.iso(item.updated_at)} for item, _ in line_items},
            "checked_at": clock.iso(now),
            "engine": ENGINE_VERSION,
            "policy_version": merchant.policy_version,
        },
        status=status,
        expires_at=now + timedelta(seconds=ttl),
        accepted_at=now if status == "ACTIVE" else None,
        trace_id=lineage_id,
    )
    db.add(quote)
    db.flush()
    analytics.track(db, "quote_created", merchant_id=merchant.id, session_id=session_id, entity_type="quote", entity_id=quote.id,
                    properties={"source": source, "version": version, "amount_minor": quote.amount_minor, "status": status})
    audit.record(db, actor=audit.customer_actor(session_id), actor_role="customer", entity_type="quote", entity_id=quote.id,
                 action="quote_created", meta={"amount_minor": quote.amount_minor, "version": version, "status": status}, trace_id=lineage_id)
    return quote


def active_reservation(db: Session, quote_id: str, now: datetime, lock: bool = False) -> Reservation | None:
    query = select(Reservation).where(Reservation.quote_id == quote_id)
    if lock:
        query = query.with_for_update()
    res = db.scalar(query)
    if res is None:
        return None
    if res.state == "PAYMENT_IN_FLIGHT" or (res.state == "HELD" and res.expires_at > now) or res.state in ("COMMITTED", "FULFILLED"):
        return res
    return None


def validate(db: Session, quote: BundleQuote, merchant: Merchant, now: datetime) -> list[Problem]:
    """Is this quote still exactly purchasable? Held quotes keep their price until checkout."""
    if quote.status in ("SUPERSEDED", "CONVERTED"):
        return []
    res = active_reservation(db, quote.id, now)
    items = catalog_items(db, merchant, now, exclude_reservation_id=res.id if res else None)
    by_sku = {i.sku: i for i in items}
    slot = db.get(PickupSlot, quote.pickup_slot_id)
    problems = validate_lines(
        [(line["sku"], line["qty"]) for line in quote.item_lines],
        by_sku, rsv.quote_intent(quote),
        max_units=int(policy(merchant, "max_units_per_order", 12)),
        slot_ends_at=slot.ends_at if slot else None,
        require_portions=False, tz_label=_tz_label(merchant),
    )
    if res is None:
        for line in quote.item_lines:
            item = by_sku.get(line["sku"])
            if item and item.status == "active" and item.sale_minor != line["unit_sale_minor"]:
                problems.append(Problem("price_changed", f"{item.name} is now {format_money(item.sale_minor, quote.currency)} (was {format_money(line['unit_sale_minor'], quote.currency)})", line["sku"]))
        if slot is not None:
            ok, reason = pickup.slot_bookable(slot, merchant, now)
            if not ok:
                problems.append(Problem("slot_unavailable", reason or "Pickup slot unavailable"))
        if quote.expires_at <= now and not problems:
            problems.append(Problem("expired", "This quote expired; we'll re-check prices and stock"))
    # The over-budget check is redundant with price changes for an existing quote.
    return [p for p in problems if p.kind != "over_budget" or res is None]


def latest_in_lineage(db: Session, lineage_id: str) -> BundleQuote | None:
    return db.scalar(
        select(BundleQuote)
        .where(BundleQuote.lineage_id == lineage_id, BundleQuote.status.in_(["ACTIVE", "CONVERTED"]))
        .order_by(BundleQuote.quote_version.desc())
        .limit(1)
    )


def view(db: Session, quote: BundleQuote, merchant: Merchant, now: datetime, *, problems: list[Problem] | None = None,
         include_offer: bool = True) -> dict[str, Any]:
    from app.services import substitution  # noqa: PLC0415 - substitution imports this module

    res = db.scalar(select(Reservation).where(Reservation.quote_id == quote.id))
    intent = rsv.quote_intent(quote)
    pending_offer = substitution.pending_offer_view(db, quote, merchant) if include_offer else None
    latest = None
    if quote.status == "SUPERSEDED":
        newest = latest_in_lineage(db, quote.lineage_id)
        latest = newest.id if newest else None
    seconds_left = max(0, int((quote.expires_at - now).total_seconds()))
    return {
        "id": quote.id,
        "lineage_id": quote.lineage_id,
        "version": quote.quote_version,
        "status": quote.status,
        "source": quote.source,
        "currency": quote.currency,
        "merchant": merchant_ref(merchant),
        "lines": quote.item_lines,
        "totals": {
            "reference_minor": quote.subtotal_reference_minor,
            "subtotal_minor": quote.subtotal_minor,
            "discount_minor": quote.discount_minor,
            "tax_minor": quote.tax_minor,
            "fees_minor": quote.fees_minor,
            "total_minor": quote.amount_minor,
        },
        "pickup": quote.pickup_slot_snapshot,
        "expires_at": clock.iso(quote.expires_at),
        "seconds_left": seconds_left,
        "intent": intent.model_dump(mode="json") if intent else None,
        "dietary_evidence": (quote.eligibility_snapshot or {}).get("dietary_evidence", {}),
        "checked_at": (quote.eligibility_snapshot or {}).get("checked_at"),
        "inventory_snapshot": (quote.eligibility_snapshot or {}).get("inventory", {}),
        "validity": None if problems is None else {"valid": not problems, "problems": [p.to_dict() for p in problems], "checked_at": clock.iso(now)},
        "reservation": rsv.view(res, now),
        "order": None,
        "pending_offer": pending_offer,
        "latest_quote_id": latest,
        "policy_version": merchant.policy_version,
    }


def status_view(session_id: str, quote_id: str) -> dict[str, Any]:
    """Polled by the review and checkout screens: validity, hold timer and any pending offer."""
    with transaction() as db:
        quote = load_for_session(db, quote_id, session_id)
        merchant = merchant_by_id(db, quote.merchant_id)
        now = clock.now()
        problems = validate(db, quote, merchant, now)
        return view(db, quote, merchant, now, problems=problems)


def create_from_option(session_id: str, proposal_id: str, option_id: str, slot_id: str | None) -> dict[str, Any]:
    with transaction() as db:
        proposal = db.get(BundleProposal, proposal_id)
        if proposal is None or proposal.session_id != session_id:
            raise NotFound("Bundle options not found", code="proposal_missing")
        merchant = merchant_by_id(db, proposal.merchant_id)
        option = next((o for o in proposal.options if o["id"] == option_id), None)
        if option is None:
            raise NotFound("That bundle option is no longer available", code="option_missing")
        ci = db.get(CustomerIntent, proposal.intent_id)
        intent = Intent.model_validate(ci.structured_constraints) if ci else None
        now = clock.now()
        chosen_slot = slot_id or option.get("default_slot_id")
        if chosen_slot is None:
            raise Conflict("No pickup slot is available for this bundle", code="slot_unavailable")
        quote = create_quote(
            db, merchant=merchant, session_id=session_id,
            lines=[(line["sku"], line["qty"]) for line in option["lines"]],
            intent=intent, intent_id=proposal.intent_id, slot_id=chosen_slot, source="bundle", now=now,
            proposal_id=proposal_id, option_id=option_id,
        )
        analytics.track(db, "bundle_accepted", merchant_id=merchant.id, session_id=session_id, entity_type="proposal",
                        entity_id=proposal_id, properties={"option_id": option_id, "kind": option.get("kind"), "origin": option.get("origin")})
        return view(db, quote, merchant, now, problems=[])


def create_from_lines(session_id: str, lines: list[tuple[str, int]], slot_id: str, intent_id: str | None,
                      merchant_slug: str) -> dict[str, Any]:
    """Deterministic browse-and-build path (also the fallback when AI is unavailable). One shop per basket."""
    with transaction() as db:
        merchant = get_merchant(db, merchant_slug)
        intent = None
        if intent_id:
            ci = db.get(CustomerIntent, intent_id)
            if ci is None or ci.session_id != session_id:
                raise NotFound("Request not found", code="intent_missing")
            if ci.merchant_id != merchant.id:
                raise Unprocessable("That request was made at a different shop", code="merchant_mismatch")
            intent = Intent.model_validate(ci.structured_constraints)
        now = clock.now()
        quote = create_quote(db, merchant=merchant, session_id=session_id, lines=lines, intent=intent, intent_id=intent_id,
                             slot_id=slot_id, source="browse", now=now)
        return view(db, quote, merchant, now, problems=[])


def change_slot(session_id: str, quote_id: str, slot_id: str) -> dict[str, Any]:
    with transaction() as db:
        quote = load_for_session(db, quote_id, session_id, lock=True)
        merchant = merchant_by_id(db, quote.merchant_id)
        now = clock.now()
        if quote.status != "ACTIVE":
            raise Conflict("This basket can no longer be changed", code="quote_not_active")
        if active_reservation(db, quote.id, now) is not None:
            raise Conflict("Release your current hold before changing pickup time", code="quote_reserved")
        new = create_quote(
            db, merchant=merchant, session_id=session_id,
            lines=[(line["sku"], line["qty"]) for line in quote.item_lines], intent=rsv.quote_intent(quote),
            intent_id=quote.intent_id, slot_id=slot_id, source=quote.source, now=now,
            proposal_id=quote.proposal_id, option_id=quote.option_id, lineage_id=quote.lineage_id, supersedes=quote,
        )
        if new.amount_minor != quote.amount_minor:
            raise QuoteInvalid("Prices changed; review the updated basket", details={"problems": [{"kind": "price_changed", "message": "Prices changed"}]})
        quote.status = "SUPERSEDED"
        return view(db, new, merchant, now, problems=[])


def refresh(session_id: str, quote_id: str) -> dict[str, Any]:
    """Re-issue an expired but otherwise unchanged quote. Any change goes through substitution."""
    with transaction() as db:
        quote = load_for_session(db, quote_id, session_id, lock=True)
        merchant = merchant_by_id(db, quote.merchant_id)
        now = clock.now()
        if quote.status == "ACTIVE" and quote.expires_at > now:
            return view(db, quote, merchant, now, problems=validate(db, quote, merchant, now))
        problems = [p for p in validate(db, quote, merchant, now) if p.kind != "expired"]
        if quote.status not in ("ACTIVE", "EXPIRED") or problems:
            raise QuoteInvalid("The basket changed", details={"problems": [p.to_dict() for p in problems]})
        new = create_quote(
            db, merchant=merchant, session_id=session_id,
            lines=[(line["sku"], line["qty"]) for line in quote.item_lines], intent=rsv.quote_intent(quote),
            intent_id=quote.intent_id, slot_id=quote.pickup_slot_id, source=quote.source, now=now,
            proposal_id=quote.proposal_id, option_id=quote.option_id, lineage_id=quote.lineage_id, supersedes=quote,
        )
        if new.amount_minor != quote.amount_minor:
            raise QuoteInvalid("Prices changed", details={"problems": [{"kind": "price_changed", "message": "Prices changed"}]})
        quote.status = "SUPERSEDED"
        return view(db, new, merchant, now, problems=[])
