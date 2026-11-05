"""RecommendationService: feasible bundle options with evidence, plus optional L2 explanations.

Flow: hard-filter the catalog -> bounded enumeration -> deterministic scoring -> pick best
fit / budget pick / most variety -> (optional) L2 writes short rationales and may propose
extra candidates, which go through the same validator and scorer. Ranking is always the
recorded deterministic score; there is no hidden "AI confidence".
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from app import clock
from app.ai import prompts
from app.ai.provider import invoke_structured
from app.ai.sanitize import clean_customer_prose
from app.config import settings
from app.db import transaction
from app.domain import ALLERGEN_LABELS, Intent
from app.errors import NotFound, Unprocessable
from app.ids import new_id
from app.models import BundleProposal, CustomerIntent, Merchant, PickupSlot
from app.money import format_money
from app.services import analytics, pickup
from app.services.catalog import CatalogItem, allergen_view, catalog_items, image_view, merchant_by_id, merchant_ref, policy
from app.services.feasibility import (
    DEFAULT_WEIGHTS,
    ENGINE_VERSION,
    ItemCheck,
    PlanContext,
    ScoredBundle,
    check_items,
    enumerate_bundles,
    exclusion_phrase,
    minimum_cost_for_party,
    price_lines,
    score_lines,
    select_options,
    validate_lines,
)


def _fmt(minor: int, currency: str) -> str:
    return format_money(minor, currency)


def _flavor_mix(sb: ScoredBundle) -> str:
    sweet = sum(q for i, q in sb.lines if i.flavor == "sweet")
    savory = sb.units - sweet
    if sweet and savory:
        return f"{sweet} sweet + {savory} savory"
    return "all sweet" if sweet else "all savory"


def _exclusion_fit(intent: Intent, checks_by_sku: dict[str, ItemCheck], sb: ScoredBundle) -> dict[str, Any] | None:
    if not intent.exclusions and not intent.dietary:
        return None
    strict = [e for e in intent.exclusions if e.is_strict]
    prefs = [e for e in intent.exclusions if not e.is_strict]
    unverified = [i.name for i, _ in sb.lines if any(ev["status"] == "unverified_preference" for ev in checks_by_sku[i.sku].dietary_evidence)]
    parts = []
    if strict:
        labels = ", ".join(ALLERGEN_LABELS[e.code] for e in strict)
        parts.append(f"Strict: every item is merchant-verified free of {labels}, with no listed cross-contact")
    if prefs:
        labels = ", ".join(ALLERGEN_LABELS[e.code] for e in prefs)
        note = f"; allergen info not yet verified for {', '.join(unverified)}" if unverified else ""
        parts.append(f"Preference: no item lists {labels} as an ingredient{note}")
    if intent.dietary:
        parts.append(f"Merchant-verified {', '.join(intent.dietary)}")
    return {"key": "exclusions", "ok": True, "label": ". ".join(parts), "source": "Merchant-supplied allergen records"}


def _option_view(kind: str, label: str, sb: ScoredBundle, intent: Intent, merchant: Merchant, slots: list[PickupSlot],
                 checks_by_sku: dict[str, ItemCheck], now: datetime, index: int, rationale: dict[str, str]) -> dict[str, Any]:
    cur = merchant.currency
    totals = price_lines(list(sb.lines), dict(policy(merchant, "tax_rates_bps", {})), int(policy(merchant, "fees_minor", 0)))
    earliest_cutoff = min(i.cutoff_at for i, _ in sb.lines)
    fitting = [s for s in slots if s.ends_at <= earliest_cutoff and pickup.slot_bookable(s, merchant, now)[0]]
    lines = []
    for item, qty in sorted(sb.lines, key=lambda x: (x[0].category, x[0].name)):
        lines.append({
            "sku": item.sku,
            "product_id": item.product_id,
            "name": item.name,
            "qty": qty,
            "category": item.category,
            "flavor": item.flavor,
            "unit_sale_minor": item.sale_minor,
            "unit_reference_minor": item.reference_minor,
            "line_total_minor": item.sale_minor * qty,
            "line_reference_minor": item.reference_minor * qty,
            "available": item.available,
            "stock_limited": qty >= item.available,
            "image": image_view(item),
            "allergens": allergen_view(item.allergens, item.allergen_source),
            "cutoff_label": clock.display_time(item.cutoff_at, merchant.timezone),
        })
    party = intent.party_size or 1
    per_person = sb.servings / party
    fits: list[dict[str, Any]] = [
        {"key": "party", "ok": True, "label": f"Feeds {party}: {sb.units} items, about {per_person:.1f} per person"},
    ]
    if intent.budget_minor:
        fits.append({"key": "budget", "ok": True, "label": f"{_fmt(totals['total_minor'], cur)} of your {_fmt(intent.budget_minor, cur)} budget"})
    excl = _exclusion_fit(intent, checks_by_sku, sb)
    if excl:
        fits.append(excl)
    if fitting:
        fits.append({
            "key": "pickup", "ok": True,
            "label": f"Pickup {pickup.slot_label(fitting[0], merchant.timezone)}; items held until {clock.display_time(earliest_cutoff, merchant.timezone)}",
        })
    if totals["discount_minor"] > 0:
        pct = round(100 * totals["discount_minor"] / totals["reference_minor"])
        fits.append({"key": "savings", "ok": True, "label": f"Saves {_fmt(totals['discount_minor'], cur)} ({pct}%) vs. regular menu prices", "source": "Merchant reference prices"})
    why = f"{sb.units} items ({_flavor_mix(sb)}) for {party} {'person' if party == 1 else 'people'}"
    if intent.budget_minor:
        why += f", {_fmt(totals['total_minor'], cur)} of your {_fmt(intent.budget_minor, cur)} budget"
    flags = ["stock_limited"] if any(line["stock_limited"] for line in lines) else []
    return {
        "id": f"opt-{index}",
        "kind": kind,
        "label": label,
        "origin": sb.origin,
        "lines": lines,
        "totals": {"currency": cur, **totals},
        "units": sb.units,
        "servings": sb.servings,
        "fits": fits,
        "why": why,
        "rationale": rationale,
        "score": {
            "total": sb.total_score,
            "components": {
                name: {"score": round(c.score, 3), "weight": round(c.weight, 3), "contribution": round(c.contribution, 3), "detail": c.detail}
                for name, c in sb.components.items()
            },
        },
        "pickup_slots": [pickup.slot_view(s, merchant, now) for s in fitting],
        "default_slot_id": fitting[0].id if fitting else None,
        "flags": flags,
    }


def _rules_rationale(kind: str, sb: ScoredBundle, intent: Intent) -> str:
    if kind == "budget_pick":
        return f"The lowest-priced combination that still covers {intent.party_size or 1}."
    if kind == "most_variety":
        cats = len({i.category for i, _ in sb.lines})
        return f"{len(sb.lines)} different items across {cats} categories for the widest spread."
    top = sorted(sb.components.items(), key=lambda kv: -kv[1].contribution)[:2]
    names = {"preference_fit": "matches your preferences", "variety": "good variety", "value": "strong value",
             "surplus_priority": "helps the shop clear today's surplus", "portion_fit": "right-sized portions"}
    return "Highest overall score: " + " and ".join(names[k] for k, _ in top) + "."


def _no_match(intent: Intent, items: list[CatalogItem], checks: list[ItemCheck], ctx: PlanContext, merchant: Merchant,
              window_slots: list[PickupSlot], all_bookable: list[PickupSlot], now: datetime) -> dict[str, Any]:
    cur = merchant.currency
    reasons: list[str] = []
    suggestions: list[dict[str, Any]] = []
    active = [i for i in items if i.sellable]
    eligible = [c.item for c in checks if c.eligible]
    if not window_slots:
        reasons.append("No pickup slots are available in your pickup window.")
        if all_bookable:
            suggestions.append({"action": "set_pickup", "label": f"Pick up {pickup.slot_label(all_bookable[0], merchant.timezone)}",
                                "value": [clock.hhmm(all_bookable[0].starts_at, merchant.timezone), clock.hhmm(all_bookable[0].ends_at, merchant.timezone)],
                                "date": all_bookable[0].starts_at.astimezone(ZoneInfo(merchant.timezone)).date().isoformat()})
    elif not active:
        reasons.append("This shop has no surplus items listed right now.")
    elif not eligible:
        dietary_blocked = [c for c in checks if c.item.sellable and any("verified" in r or "Contains" in r or "May contain" in r for r in c.reasons)]
        if intent.exclusions or intent.dietary:
            if len(dietary_blocked) == len([c for c in checks if c.item.sellable]):
                reasons.append(f"No items available today are merchant-verified to meet your dietary needs ({exclusion_phrase(intent)}).")
            else:
                reasons.append("Items that meet your dietary needs aren't available for your pickup time.")
        else:
            reasons.append("No items are available for your pickup time.")
        suggestions.append({"action": "browse", "label": "Browse all items with full allergen details"})
    else:
        cost = minimum_cost_for_party(eligible, ctx)
        if cost is None:
            servings = sum(i.available * i.servings for i in eligible)
            people = int(servings // max(1e-9, ctx.min_servings / ctx.party_size))
            reasons.append(f"Only about {servings:g} eligible servings are left today, not enough for {ctx.party_size} people.")
            if people >= 1:
                suggestions.append({"action": "set_party_size", "label": f"Plan for {people} {'person' if people == 1 else 'people'}", "value": people})
        elif intent.budget_minor is not None and cost > intent.budget_minor:
            reasons.append(f"The lowest-cost bundle for {ctx.party_size} people is {_fmt(cost, cur)}, above your {_fmt(intent.budget_minor, cur)} budget.")
            suggestions.append({"action": "set_budget", "label": f"Raise budget to {_fmt(cost, cur)}", "value": cost})
            suggestions.append({"action": "set_party_size", "label": f"Plan for {max(1, ctx.party_size - 1)} people", "value": max(1, ctx.party_size - 1)})
        else:
            reasons.append("No combination of available items fits every constraint.")
    if not any(s["action"] == "browse" for s in suggestions):
        suggestions.append({"action": "browse", "label": "See available items"})
    return {"headline": reasons[0] if reasons else "No bundle fits your request right now.", "reasons": reasons, "suggestions": suggestions}


def propose(intent_id: str, session_id: str) -> dict[str, Any]:
    with transaction() as db:
        ci = db.get(CustomerIntent, intent_id)
        if ci is None or ci.session_id != session_id:
            raise NotFound("We couldn't find that request; please describe it again", code="intent_missing")
        merchant = merchant_by_id(db, ci.merchant_id)
        intent = Intent.model_validate(ci.structured_constraints)
        if intent.party_size is None:
            raise Unprocessable("Tell us how many people you're shopping for", code="party_size_required")
        now = clock.now()
        pickup.ensure_slots(db, merchant, now)
        slots = pickup.list_slots(db, merchant, now)
        bookable = [s for s in slots if pickup.slot_bookable(s, merchant, now)[0]]
        window_slots = [s for s in pickup.slots_for_window(slots, merchant, intent.pickup_date, intent.pickup_window) if s in bookable]
        items = catalog_items(db, merchant, now)
        for obj in [merchant, *slots]:
            db.expunge(obj)

    target_end = window_slots[0].ends_at if window_slots else None
    tz_label = lambda dt: clock.display_time(dt, merchant.timezone)  # noqa: E731
    checks = check_items(items, intent, target_end, tz_label)
    checks_by_sku = {c.item.sku: c for c in checks}
    eligible = [c.item for c in checks if c.eligible] if window_slots else []
    ctx = PlanContext.build(intent, int(policy(merchant, "max_units_per_order", 12)))
    weights = dict(policy(merchant, "scoring_weights", DEFAULT_WEIGHTS))
    scored = [score_lines(lines, intent, ctx, weights, now) for lines in enumerate_bundles(eligible, ctx)]
    chosen = select_options(scored)

    ai_meta: dict[str, Any] = {"used": False}
    rationales: dict[str, dict[str, str]] = {}
    ai_invocation_id = None
    if chosen and settings().ai_bundle_rationale:
        chosen, rationales, ai_meta, ai_invocation_id = _ai_pass(chosen, scored, eligible, intent, ctx, weights, merchant, now)

    options = []
    for idx, (kind, label, sb) in enumerate(chosen, start=1):
        rationale = rationales.get(f"opt-{idx}") or {"text": _rules_rationale(kind, sb, intent), "source": "rules"}
        options.append(_option_view(kind, label, sb, intent, merchant, window_slots, checks_by_sku, now, idx, rationale))
    options = [o for o in options if o["default_slot_id"]]

    no_match = None
    if not options:
        no_match = _no_match(intent, items, checks, ctx, merchant, window_slots, bookable, now)
    excluded = [
        {"sku": c.item.sku, "name": c.item.name, "reasons": c.reasons}
        for c in checks if not c.eligible and c.item.status == "active"
    ]
    proposal_id = new_id("prp")
    with transaction() as db:
        db.add(BundleProposal(
            id=proposal_id, merchant_id=merchant.id, session_id=session_id, intent_id=intent_id, options=options,
            no_match=no_match, excluded=excluded, engine_version=ENGINE_VERSION, ai_invocation_id=ai_invocation_id,
            inventory_as_of=now,
        ))
        analytics.track(db, "bundle_proposed", merchant_id=merchant.id, session_id=session_id, entity_type="proposal", entity_id=proposal_id,
                        properties={"options": len(options), "no_match": no_match is not None, "ai_used": ai_meta.get("used", False)})
    return {
        "proposal_id": proposal_id,
        "merchant": merchant_ref(merchant),
        "intent_id": intent_id,
        "intent": intent.model_dump(mode="json"),
        "options": options,
        "no_match": no_match,
        "excluded": excluded,
        "inventory_as_of": clock.iso(now),
        "engine": {"version": ENGINE_VERSION, "weights": weights, "candidates_considered": len(scored)},
        "ai": ai_meta,
        "pickup_window_slots": [pickup.slot_view(s, merchant, now) for s in window_slots],
    }


def _ai_pass(chosen, scored, eligible, intent, ctx, weights, merchant, now):
    """L2: rationales for engine options plus optional extra candidates (validated like any basket)."""
    by_sku = {i.sku: i for i in eligible}
    payload = {
        "request": intent.model_dump(mode="json", exclude={"currency"}),
        "eligible_catalog": [
            {"sku": i.sku, "name": i.name, "category": i.category, "flavor": i.flavor, "tags": list(i.tags),
             "servings_per_unit": i.servings, "available": i.available, "merchant_description_untrusted": i.description[:240]}
            for i in eligible
        ],
        "options": [
            {"option_id": f"opt-{idx}", "label": label, "items": [{"sku": i.sku, "name": i.name, "qty": q} for i, q in sb.lines]}
            for idx, (_, label, sb) in enumerate(chosen, start=1)
        ],
    }
    max_units = int(policy(merchant, "max_units_per_order", 12))

    def semantic(plan: prompts.AIBundlePlan) -> list[str]:
        notes = []
        for cand in plan.candidates:
            problems = validate_lines([(line.sku, line.qty) for line in cand.items], by_sku, intent, max_units=max_units,
                                      slot_ends_at=None, require_portions=True, ctx=ctx)
            if problems:
                notes.append("rejected candidate: " + "; ".join(p.message for p in problems))
        return notes

    outcome = invoke_structured(
        task="L2_bundle",
        prompt_version=prompts.BUNDLE_PROMPT_VERSION,
        system=prompts.BUNDLE_SYSTEM,
        payload=payload,
        output_model=prompts.AIBundlePlan,
        semantic_check=semantic,
    )
    meta = {"used": outcome.ok, "model": outcome.model, "latency_ms": outcome.latency_ms, "fallback_reason": None if outcome.ok else outcome.reason,
            "rejected_candidates": len(outcome.notes)}
    if not outcome.ok:
        return chosen, {}, meta, outcome.invocation_id
    plan: prompts.AIBundlePlan = outcome.data
    pool = list(scored)
    accepted_ai = 0
    for cand in plan.candidates:
        lines_raw = [(line.sku, line.qty) for line in cand.items]
        problems = validate_lines(lines_raw, by_sku, intent, max_units=max_units, slot_ends_at=None, require_portions=True, ctx=ctx)
        if problems:
            continue
        merged: dict[str, int] = {}
        for sku, qty in lines_raw:
            merged[sku] = merged.get(sku, 0) + qty
        sb = score_lines(tuple((by_sku[s], q) for s, q in sorted(merged.items())), intent, ctx, weights, now)
        if sb.servings > ctx.max_servings + 1e-9:
            continue
        sb.origin = "ai_candidate"
        if all(sb.key != other.key for other in pool):
            pool.append(sb)
            accepted_ai += 1
    meta["accepted_candidates"] = accepted_ai
    reselected = select_options(pool) if accepted_ai else chosen
    by_option = {r.option_id: r.rationale for r in plan.rationales}
    rationales: dict[str, dict[str, str]] = {}
    original_ids = {sb.key: f"opt-{idx}" for idx, (_, _, sb) in enumerate(chosen, start=1)}
    ai_reasons = {}
    for cand in plan.candidates:
        key = tuple(sorted((line.sku, line.qty) for line in cand.items))
        ai_reasons[key] = cand.rationale
    for idx, (_, _, sb) in enumerate(reselected, start=1):
        text = by_option.get(original_ids.get(sb.key, ""), "") or ai_reasons.get(sb.key, "")
        cleaned = clean_customer_prose(text, max_chars=200) if text else ""
        if cleaned:
            rationales[f"opt-{idx}"] = {"text": cleaned, "source": "ai"}
    return reselected, rationales, meta, outcome.invocation_id
