"""Substitution flow (L3). Code chooses allowable replacements; the model only explains them.

A stock, price or eligibility change invalidates the quote. We then create a PROPOSED quote
with a before/after comparison. Nothing changes for the customer until they explicitly accept
it, and a payment can only be made against an accepted, active quote.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.ai import prompts
from app.ai.provider import invoke_structured
from app.ai.sanitize import clean_customer_prose
from app.db import transaction
from app.domain import Intent
from app.errors import Conflict, NotFound, QuoteInvalid, Unprocessable
from app.ids import new_id
from app.models import BundleQuote, Merchant, PickupSlot, SubstitutionOffer
from app.money import format_money
from app.services import analytics, audit
from app.services import quotes as qs
from app.services import reservations as rsv
from app.services.catalog import catalog_items, merchant_by_id, policy
from app.services.feasibility import PlanContext, Problem, check_items, price_lines, replacement_options

STOCK_KINDS = {"sold_out", "insufficient_stock"}
REMOVE_KINDS = {"paused", "dietary", "cutoff"}


def offer_view(db: Session, offer: SubstitutionOffer) -> dict[str, Any]:
    return {
        "id": offer.id,
        "state": offer.state,
        "trigger": offer.trigger,
        "reasons": offer.reasons,
        "comparison": offer.comparison,
        "alternatives": offer.alternatives,
        "explanation": offer.explanation,
        "explanation_source": offer.explanation_source,
        "original_quote_id": offer.original_quote_id,
        "proposed_quote_id": offer.proposed_quote_id,
        "created_at": clock.iso(offer.created_at),
    }


def pending_offer_view(db: Session, quote: BundleQuote, merchant: Merchant) -> dict[str, Any] | None:
    offer = db.scalar(
        select(SubstitutionOffer)
        .where(SubstitutionOffer.original_quote_id == quote.id, SubstitutionOffer.state == "OFFERED")
        .order_by(SubstitutionOffer.created_at.desc())
        .limit(1)
    )
    return offer_view(db, offer) if offer else None


def _line_summary(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"sku": line["sku"], "name": line["name"], "qty": line["qty"], "line_total_minor": line["line_total_minor"]} for line in lines]


def _comparison(original: BundleQuote, proposed: BundleQuote | None, merchant: Merchant, now: datetime,
                updated_at: datetime | None) -> dict[str, Any]:
    before = {line["sku"]: line for line in original.item_lines}
    after = {line["sku"]: line for line in proposed.item_lines} if proposed else {}
    removed, added, changed = [], [], []
    for sku, line in before.items():
        if sku not in after:
            removed.append({"sku": sku, "name": line["name"], "qty": line["qty"]})
        elif after[sku]["qty"] != line["qty"]:
            changed.append({"sku": sku, "name": line["name"], "from_qty": line["qty"], "to_qty": after[sku]["qty"]})
    for sku, line in after.items():
        if sku not in before:
            added.append({
                "sku": sku, "name": line["name"], "qty": line["qty"], "unit_sale_minor": line["unit_sale_minor"],
                "allergens": line["allergens"], "image": line["image"],
            })
    intent = rsv.quote_intent(original)
    budget = intent.budget_minor if intent else None
    return {
        "currency": original.currency,
        "before": {"lines": _line_summary(original.item_lines), "total_minor": original.amount_minor},
        "after": {"lines": _line_summary(proposed.item_lines), "total_minor": proposed.amount_minor} if proposed else None,
        "removed": removed,
        "added": added,
        "changed": changed,
        "delta_minor": (proposed.amount_minor - original.amount_minor) if proposed else None,
        "budget_minor": budget,
        "within_budget": (proposed.amount_minor <= budget) if (proposed and budget) else True,
        "pickup": {"unchanged": True, "label": original.pickup_slot_snapshot.get("label")},
        "dietary_evidence": (proposed.eligibility_snapshot or {}).get("dietary_evidence", {}) if proposed else {},
        "inventory_checked_at": clock.iso(now),
        "inventory_updated_at": clock.iso(updated_at) if updated_at else None,
        "no_replacement": proposed is None,
    }


def _rules_explanation(trigger: str, comparison: dict[str, Any], reasons: list[dict[str, Any]], kind: str) -> str:
    cur = comparison["currency"]
    before = format_money(comparison["before"]["total_minor"], cur)
    pickup_label = comparison["pickup"]["label"]
    removed = ", ".join(r["name"] for r in comparison["removed"]) or ", ".join(c["name"] for c in comparison["changed"])
    if comparison["after"] is None:
        cause = reasons[0]["message"] if reasons else "An item is no longer available"
        return f"{cause}. No other item fits your request, so choose another bundle or browse what's available."
    after = format_money(comparison["after"]["total_minor"], cur)
    added = ", ".join(f"{a['qty']} {a['name']}" for a in comparison["added"])
    if trigger == "price_change":
        return f"The shop updated a price, so your total is now {after} (was {before}). Pickup stays {pickup_label}."
    if trigger == "customer_swap":
        return f"Swapping {removed} for {added} changes your total from {before} to {after}. Pickup stays {pickup_label}."
    cause = reasons[0]["message"] if reasons else f"{removed} is no longer available"
    if kind == "remove":
        return f"{cause}. The rest of your bundle still covers your group, and your total drops from {before} to {after}."
    return f"{cause}, so we suggest {added} instead. Your total changes from {before} to {after}; pickup stays {pickup_label}."


def propose(session_id: str, quote_id: str, replace_sku: str | None = None, with_sku: str | None = None) -> dict[str, Any]:
    with transaction() as db:
        quote = qs.load_for_session(db, quote_id, session_id, lock=True)
        merchant = merchant_by_id(db, quote.merchant_id)
        now = clock.now()
        if quote.status not in ("ACTIVE", "INVALIDATED", "EXPIRED"):
            raise Conflict("This basket can no longer be changed", code="quote_not_changeable", details={"status": quote.status})
        res = qs.active_reservation(db, quote.id, now)
        if res is not None and res.state != "HELD":
            raise Conflict("Payment is in progress for this basket", code="payment_in_progress")
        problems = [] if replace_sku else qs.validate(db, quote, merchant, now)
        actionable = [p for p in problems if p.kind in STOCK_KINDS | REMOVE_KINDS | {"price_changed"}]
        if replace_sku is None and not actionable:
            return {"needed": False, "problems": [p.to_dict() for p in problems]}
        if replace_sku is not None and replace_sku not in {line["sku"] for line in quote.item_lines}:
            raise Unprocessable("That item isn't in your basket", code="not_in_basket")

        trigger = "customer_swap" if replace_sku else (
            "stock_change" if any(p.kind in STOCK_KINDS for p in actionable)
            else "price_change" if all(p.kind == "price_changed" for p in actionable)
            else "eligibility_change"
        )
        reasons = [p.to_dict() for p in actionable] if not replace_sku else [{"kind": "customer_swap", "message": "You asked to swap an item", "sku": replace_sku}]
        signature = sorted((r.get("kind"), r.get("sku"), r.get("available")) for r in reasons)
        if with_sku is None:
            for existing in db.scalars(select(SubstitutionOffer).where(SubstitutionOffer.original_quote_id == quote.id, SubstitutionOffer.state == "OFFERED")).all():
                if existing.trigger == trigger and sorted((r.get("kind"), r.get("sku"), r.get("available")) for r in existing.reasons) == signature:
                    return offer_view(db, existing)

        intent = rsv.quote_intent(quote) or Intent()
        items = catalog_items(db, merchant, now, exclude_reservation_id=res.id if res else None)
        by_sku = {i.sku: i for i in items}
        slot = db.get(PickupSlot, quote.pickup_slot_id)
        tz_label = lambda dt: clock.display_time(dt, merchant.timezone)  # noqa: E731
        eligible = [c.item for c in check_items(items, intent, slot.ends_at if slot else None, tz_label) if c.eligible]
        max_units = int(policy(merchant, "max_units_per_order", 12))
        current = [(by_sku[line["sku"]], line["qty"]) for line in quote.item_lines if line["sku"] in by_sku]

        if trigger == "price_change":
            options = [{"kind": "reprice", "add_sku": None, "add_qty": 0, "lines": [(line["sku"], line["qty"]) for line in quote.item_lines]}]
        else:
            shortfalls: dict[str, int] = {}
            qty_by_sku = {line["sku"]: line["qty"] for line in quote.item_lines}
            for p in actionable:
                if p.sku and p.kind in STOCK_KINDS:
                    shortfalls[p.sku] = qty_by_sku[p.sku] - (p.available or 0)
                elif p.sku and p.kind in REMOVE_KINDS:
                    shortfalls[p.sku] = qty_by_sku[p.sku]
            if replace_sku:
                shortfalls[replace_sku] = qty_by_sku[replace_sku]
            ctx = PlanContext.build(intent, max_units) if intent.party_size else None
            options = replacement_options(current, shortfalls, eligible, intent, ctx, max_units)
            if replace_sku:
                options = [o for o in options if o["kind"] == "replace"]
        if with_sku:
            options = [o for o in options if o.get("add_sku") == with_sku]
            if not options:
                raise Unprocessable("That item can't replace this one within your budget, dietary needs and stock", code="replacement_not_allowed")

        involved = [by_sku[s] for s in {line["sku"] for line in quote.item_lines} | {o.get("add_sku") for o in options if o.get("add_sku")} if s in by_sku]
        updated_at = max((i.updated_at for i in involved), default=None)
        proposed: BundleQuote | None = None
        chosen_kind = "none"
        if options:
            chosen = options[0]
            chosen_kind = chosen["kind"]
            proposed = qs.create_quote(
                db, merchant=merchant, session_id=session_id, lines=[(s, q) for s, q in chosen["lines"]], intent=rsv.quote_intent(quote),
                intent_id=quote.intent_id, slot_id=quote.pickup_slot_id, source=quote.source, now=now,
                proposal_id=quote.proposal_id, option_id=quote.option_id, lineage_id=quote.lineage_id, supersedes=quote,
                status="PROPOSED", exclude_reservation_id=res.id if res else None, held_slot_id=quote.pickup_slot_id if res else None,
            )
        comparison = _comparison(quote, proposed, merchant, now, updated_at)
        alternatives = []
        for option in options[1:]:
            lines = [(by_sku[s], q) for s, q in option["lines"]]
            total = price_lines(lines, dict(policy(merchant, "tax_rates_bps", {})), int(policy(merchant, "fees_minor", 0)))["total_minor"]
            alternatives.append({
                "kind": option["kind"],
                "add_sku": option.get("add_sku"),
                "add_name": by_sku[option["add_sku"]].name if option.get("add_sku") else None,
                "add_qty": option.get("add_qty"),
                "total_minor": total,
                "delta_minor": total - quote.amount_minor,
                "lines": [{"sku": s, "name": by_sku[s].name, "qty": q} for s, q in option["lines"]],
            })
        for older in db.scalars(select(SubstitutionOffer).where(SubstitutionOffer.original_quote_id == quote.id, SubstitutionOffer.state == "OFFERED")).all():
            older.state = "EXPIRED"
            older.decided_at = now
        offer = SubstitutionOffer(
            id=new_id("sub"),
            original_quote_id=quote.id,
            proposed_quote_id=proposed.id if proposed else None,
            session_id=session_id,
            trigger=trigger,
            reasons=reasons,
            comparison=comparison,
            alternatives=alternatives,
            explanation=_rules_explanation(trigger, comparison, reasons, chosen_kind),
            explanation_source="rules",
            state="OFFERED",
        )
        db.add(offer)
        if trigger != "customer_swap":
            quote.status = "INVALIDATED"
            quote.invalid_reason = reasons
        analytics.track(db, "substitution_offered", merchant_id=merchant.id, session_id=session_id, entity_type="substitution",
                        entity_id=offer.id, properties={"trigger": trigger, "has_replacement": proposed is not None})
        audit.record(db, actor="system:substitution", actor_role="system", entity_type="quote", entity_id=quote.id,
                     action="substitution_offered", meta={"offer_id": offer.id, "trigger": trigger, "reasons": reasons}, trace_id=quote.trace_id)
        offer_id = offer.id

    _explain_with_ai(offer_id, comparison, reasons, trigger)
    with transaction() as db:
        return offer_view(db, db.get(SubstitutionOffer, offer_id))


def _explain_with_ai(offer_id: str, comparison: dict[str, Any], reasons: list[dict[str, Any]], trigger: str) -> None:
    if comparison["after"] is None:
        return
    cur = comparison["currency"]
    before = format_money(comparison["before"]["total_minor"], cur)
    after = format_money(comparison["after"]["total_minor"], cur)
    outcome = invoke_structured(
        task="L3_substitution",
        prompt_version=prompts.SUBSTITUTION_PROMPT_VERSION,
        system=prompts.SUBSTITUTION_SYSTEM,
        payload={
            "trigger": trigger,
            "reasons": [r["message"] for r in reasons],
            "removed": [f"{r['qty']} {r['name']}" for r in comparison["removed"]],
            "changed": [f"{c['name']}: {c['from_qty']} -> {c['to_qty']}" for c in comparison["changed"]],
            "added": [f"{a['qty']} {a['name']}" for a in comparison["added"]],
            "before_total": before,
            "after_total": after,
            "pickup": comparison["pickup"]["label"],
        },
        output_model=prompts.AISubstitution,
    )
    if not outcome.ok:
        return
    text = clean_customer_prose(outcome.data.explanation, allowed_amounts={before, after}, max_chars=280)
    if not text:
        return
    with transaction() as db:
        offer = db.get(SubstitutionOffer, offer_id, with_for_update=True)
        if offer and offer.state == "OFFERED":
            offer.explanation = text
            offer.explanation_source = "ai"
            offer.ai_invocation_id = outcome.invocation_id


def accept(session_id: str, offer_id: str) -> dict[str, Any]:
    with transaction() as db:
        offer = db.get(SubstitutionOffer, offer_id, with_for_update=True)
        if offer is None or offer.session_id != session_id:
            raise NotFound("Change proposal not found", code="offer_missing")
        merchant = merchant_by_id(db, db.get(BundleQuote, offer.original_quote_id).merchant_id)
        now = clock.now()
        if offer.state == "ACCEPTED" and offer.proposed_quote_id:
            proposed = db.get(BundleQuote, offer.proposed_quote_id)
            return qs.view(db, proposed, merchant, now, problems=qs.validate(db, proposed, merchant, now))
        if offer.state != "OFFERED":
            raise Conflict("This change proposal is no longer open", code="offer_closed", details={"state": offer.state})
        if offer.proposed_quote_id is None:
            raise Conflict("There is no replacement to accept; choose another bundle", code="no_replacement")
        original = qs.load_for_session(db, offer.original_quote_id, session_id, lock=True)
        proposed = qs.load_for_session(db, offer.proposed_quote_id, session_id, lock=True)
        res = qs.active_reservation(db, original.id, now, lock=True)
        if res is not None:
            if res.state != "HELD":
                raise Conflict("Payment is in progress for the previous basket", code="payment_in_progress")
            rsv.release(db, res, "substituted", now, actor=audit.customer_actor(session_id), role="customer")
        problems = [p for p in qs.validate(db, proposed, merchant, now) if p.kind != "expired"]
        if problems:
            raise QuoteInvalid("Stock changed again; we'll prepare a new proposal", details={"problems": [p.to_dict() for p in problems]})
        proposed.status = "ACTIVE"
        proposed.accepted_at = now
        proposed.expires_at = now + timedelta(seconds=int(policy(merchant, "quote_ttl_seconds", 900)))
        original.status = "SUPERSEDED"
        offer.state = "ACCEPTED"
        offer.decided_at = now
        analytics.track(db, "substitution_accepted", merchant_id=merchant.id, session_id=session_id, entity_type="substitution",
                        entity_id=offer.id, properties={"trigger": offer.trigger, "delta_minor": offer.comparison.get("delta_minor")})
        audit.record(db, actor=audit.customer_actor(session_id), actor_role="customer", entity_type="quote", entity_id=proposed.id,
                     action="substitution_accepted", meta={"offer_id": offer.id, "previous_quote_id": original.id}, trace_id=proposed.trace_id)
        return qs.view(db, proposed, merchant, now, problems=[])


def reject(session_id: str, offer_id: str) -> dict[str, Any]:
    with transaction() as db:
        offer = db.get(SubstitutionOffer, offer_id, with_for_update=True)
        if offer is None or offer.session_id != session_id:
            raise NotFound("Change proposal not found", code="offer_missing")
        merchant = merchant_by_id(db, db.get(BundleQuote, offer.original_quote_id).merchant_id)
        if offer.state == "OFFERED":
            offer.state = "REJECTED"
            offer.decided_at = clock.now()
            analytics.track(db, "substitution_rejected", merchant_id=merchant.id, session_id=session_id, entity_type="substitution",
                            entity_id=offer.id, properties={"trigger": offer.trigger})
        return offer_view(db, offer)


def offer_for_problems(session_id: str, quote_id: str) -> dict[str, Any] | None:
    """Best-effort offer used when a reservation or checkout fails on a changed basket."""
    try:
        result = propose(session_id, quote_id)
    except (Conflict, NotFound, QuoteInvalid, Unprocessable):
        return None
    return None if result.get("needed") is False else result


__all__ = ["propose", "accept", "reject", "offer_view", "pending_offer_view", "offer_for_problems", "Problem"]
