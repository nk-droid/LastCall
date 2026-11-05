"""BundleFeasibilityEngine: deterministic, bounded enumeration with a recorded scoring breakdown.

Hard constraints (never traded off): stock, dietary exclusions, budget, pickup cutoff,
merchant eligibility (active listings), per-item and per-order quantity bounds.
Soft objectives (weighted, configurable): preference fit, variety, value, surplus priority,
portion fit. Model output is never trusted here; candidates from the LLM are validated by
``validate_lines`` exactly like any other basket.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.domain import ALLERGEN_LABELS, Intent, check_dietary
from app.money import apply_rate_bps
from app.services.catalog import CatalogItem

ENGINE_VERSION = "bundle-engine/1.3"

DEFAULT_WEIGHTS: dict[str, float] = {
    "preference_fit": 0.35,
    "variety": 0.20,
    "value": 0.15,
    "surplus_priority": 0.20,
    "portion_fit": 0.10,
}

# Servings per person: (minimum, target, maximum)
OCCASION_PORTIONS: dict[str, tuple[float, float, float]] = {
    "snacks": (1.0, 1.5, 2.0),
    "breakfast": (1.0, 1.5, 2.0),
    "brunch": (1.0, 1.5, 2.25),
    "dessert": (1.0, 1.25, 1.75),
    "party": (1.5, 2.0, 2.5),
    "office": (1.0, 1.5, 2.0),
    "picnic": (1.0, 1.5, 2.0),
    "dinner": (0.5, 1.0, 1.5),
    "other": (1.0, 1.5, 2.0),
}
SHARED_OCCASIONS = {"party", "office", "dinner"}
OCCASION_TAGS = {
    "snacks": "handheld",
    "picnic": "handheld",
    "breakfast": "breakfast",
    "brunch": "breakfast",
    "dessert": "dessert",
    "party": "shareable",
    "office": "shareable",
    "dinner": "dinner",
}


@dataclass(frozen=True)
class PlanContext:
    party_size: int
    budget_minor: int | None
    min_servings: float
    target_servings: float
    max_servings: float
    max_units: int
    min_units: int = 1
    max_distinct: int = 4
    node_limit: int = 300_000
    result_limit: int = 25_000

    @classmethod
    def build(cls, intent: Intent, max_units_per_order: int) -> PlanContext:
        party = intent.party_size or 1
        lo, mid, hi = OCCASION_PORTIONS.get(intent.occasion or "other", OCCASION_PORTIONS["other"])
        # For individual-serving occasions everyone gets at least one item; shared occasions
        # (party, office, dinner) may cover several people with one loaf or slab.
        individual = (intent.occasion or "other") not in SHARED_OCCASIONS
        return cls(
            party_size=party,
            budget_minor=intent.budget_minor,
            min_servings=party * lo,
            target_servings=party * mid,
            max_servings=max(party * hi, party * lo + 1),
            max_units=max_units_per_order,
            min_units=min(party, max_units_per_order) if individual else 1,
        )


@dataclass
class ItemCheck:
    item: CatalogItem
    eligible: bool
    reasons: list[str]
    dietary_evidence: list[dict[str, Any]]


def check_items(items: list[CatalogItem], intent: Intent, slot_ends_at: datetime | None, tz_label) -> list[ItemCheck]:
    """Apply every hard per-item constraint and record why anything was excluded."""
    checks: list[ItemCheck] = []
    for item in items:
        reasons: list[str] = []
        if item.status != "active":
            reasons.append("Listing paused by the merchant")
        elif item.available <= 0:
            reasons.append("Sold out")
        if slot_ends_at is not None and item.cutoff_at < slot_ends_at:
            reasons.append(f"Must be picked up by {tz_label(item.cutoff_at)}, before your pickup time")
        dietary = check_dietary(item.allergens, item.attributes, intent)
        reasons.extend(dietary.reasons)
        checks.append(ItemCheck(item=item, eligible=not reasons, reasons=reasons, dietary_evidence=dietary.evidence))
    return checks


Lines = tuple[tuple[CatalogItem, int], ...]


def enumerate_bundles(eligible: list[CatalogItem], ctx: PlanContext) -> list[Lines]:
    """Bounded depth-first enumeration of baskets that feed the party within budget."""
    items = sorted(eligible, key=lambda i: (-i.surplus_priority, i.sale_minor, i.sku))
    results: list[Lines] = []
    path: list[tuple[CatalogItem, int]] = []
    nodes = 0

    def dfs(start: int, total: int, units: int, servings: float) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > ctx.node_limit or len(results) >= ctx.result_limit:
            return
        if path and servings + 1e-9 >= ctx.min_servings and units >= ctx.min_units:
            results.append(tuple(path))
        if len(path) >= ctx.max_distinct:
            return
        for idx in range(start, len(items)):
            item = items[idx]
            max_q = min(item.available, item.per_order_limit, ctx.max_units - units)
            for qty in range(1, max_q + 1):
                new_total = total + qty * item.sale_minor
                if ctx.budget_minor is not None and new_total > ctx.budget_minor:
                    break
                new_servings = servings + qty * item.servings
                if new_servings > ctx.max_servings + 1e-9:
                    break
                path.append((item, qty))
                dfs(idx + 1, new_total, units + qty, new_servings)
                path.pop()

    dfs(0, 0, 0, 0.0)
    return results


# --------------------------------------------------------------------------- scoring


@dataclass
class Component:
    score: float
    weight: float
    detail: str

    @property
    def contribution(self) -> float:
        return self.score * self.weight


@dataclass
class ScoredBundle:
    lines: Lines
    total_minor: int
    reference_minor: int
    units: int
    servings: float
    components: dict[str, Component]
    total_score: float
    origin: str = "engine"
    key: tuple[tuple[str, int], ...] = field(default=())

    def skus(self) -> set[str]:
        return {item.sku for item, _ in self.lines}


def _flavor_target(intent: Intent) -> float | None:
    prefs = set(intent.preferences)
    if "sweet_and_savory" in prefs or {"sweet", "savory"} <= prefs:
        return 0.5
    if prefs & {"sweet", "chocolate", "fruit"}:
        return 0.85
    if "savory" in prefs:
        return 0.15
    return {
        "snacks": 0.5,
        "party": 0.5,
        "picnic": 0.5,
        "office": 0.5,
        "brunch": 0.5,
        "breakfast": 0.6,
        "dessert": 0.9,
        "dinner": 0.2,
    }.get(intent.occasion or "", None)


def _normalized_weights(intent: Intent, weights: dict[str, float]) -> dict[str, float]:
    w = {k: float(weights.get(k, v)) for k, v in DEFAULT_WEIGHTS.items()}
    if "variety" in intent.preferences:
        w["variety"] *= 1.5
    total = sum(w.values()) or 1.0
    return {k: v / total for k, v in w.items()}


def score_lines(lines: Lines, intent: Intent, ctx: PlanContext, weights: dict[str, float], now: datetime) -> ScoredBundle:
    w = _normalized_weights(intent, weights)
    units = sum(q for _, q in lines)
    servings = sum(q * i.servings for i, q in lines)
    total = sum(q * i.sale_minor for i, q in lines)
    reference = sum(q * i.reference_minor for i, q in lines)

    # Preference fit: flavor balance, occasion tag share, explicit preference keywords.
    parts: list[float] = []
    notes: list[str] = []
    sweet = sum(q * i.servings for i, q in lines if i.flavor == "sweet")
    sweet_share = sweet / servings if servings else 0
    target = _flavor_target(intent)
    if target is not None:
        parts.append(1 - abs(sweet_share - target))
        notes.append(f"{round(sweet_share * 100)}% sweet (target {round(target * 100)}%)")
    tag = OCCASION_TAGS.get(intent.occasion or "")
    if tag:
        share = sum(q for i, q in lines if tag in i.tags) / units
        parts.append(share)
        notes.append(f"{round(share * 100)}% {tag}")
    keyword_tags = {"chocolate": "chocolate", "fruit": "fruit", "kid_friendly": "kid_friendly", "handheld": "handheld", "shareable": "shareable"}
    for pref in intent.preferences:
        if pref == "bread":
            parts.append(sum(q for i, q in lines if i.category == "bread") / units)
        elif pref == "pastries":
            parts.append(sum(q for i, q in lines if i.category == "pastry") / units)
        elif pref in keyword_tags:
            parts.append(sum(q for i, q in lines if keyword_tags[pref] in i.tags) / units)
    preference = sum(parts) / len(parts) if parts else 0.5

    distinct = len(lines)
    categories = len({i.category for i, _ in lines})
    distinct_ratio = min(1.0, distinct / min(4, units)) if units else 0
    category_ratio = min(1.0, categories / min(3, distinct)) if distinct else 0
    variety = 0.6 * distinct_ratio + 0.4 * category_ratio

    savings_ratio = (reference - total) / reference if reference else 0
    value = min(1.0, savings_ratio / 0.5)

    priority_total = 0.0
    for item, qty in lines:
        hours_left = max(0.0, (item.cutoff_at - now).total_seconds() / 3600)
        urgency = max(0.0, min(1.0, 1 - hours_left / 6))
        priority_total += qty * ((item.surplus_priority / 3) * 0.6 + urgency * 0.4)
    surplus = priority_total / units if units else 0

    portion = max(0.0, 1 - abs(servings - ctx.target_servings) / ctx.target_servings) if ctx.target_servings else 0.5

    components = {
        "preference_fit": Component(preference, w["preference_fit"], "; ".join(notes) or "no stated preference"),
        "variety": Component(variety, w["variety"], f"{distinct} items across {categories} categories"),
        "value": Component(value, w["value"], f"{round(savings_ratio * 100)}% below reference prices"),
        "surplus_priority": Component(surplus, w["surplus_priority"], "merchant surplus priority and pickup-cutoff urgency"),
        "portion_fit": Component(portion, w["portion_fit"], f"{servings:g} servings for {ctx.party_size} (target {ctx.target_servings:g})"),
    }
    total_score = sum(c.contribution for c in components.values())
    key = tuple(sorted((i.sku, q) for i, q in lines))
    return ScoredBundle(
        lines=lines,
        total_minor=total,
        reference_minor=reference,
        units=units,
        servings=servings,
        components=components,
        total_score=round(total_score, 4),
        key=key,
    )


def _distinct_enough(candidate: ScoredBundle, chosen: list[ScoredBundle]) -> bool:
    for other in chosen:
        if candidate.key == other.key:
            return False
        a, b = candidate.skus(), other.skus()
        jaccard = len(a & b) / len(a | b) if a | b else 1
        if jaccard > 0.75 and abs(candidate.total_minor - other.total_minor) < 100:
            return False
    return True


def select_options(scored: list[ScoredBundle]) -> list[tuple[str, str, ScoredBundle]]:
    """Best fit, the cheapest feasible bundle (never hidden), and the most varied distinct one."""
    if not scored:
        return []
    by_score = sorted(scored, key=lambda b: (-b.total_score, b.total_minor, b.key))
    best = by_score[0]
    options: list[tuple[str, str, ScoredBundle]] = []
    cheapest = sorted(scored, key=lambda b: (b.total_minor, -b.total_score, b.key))
    if cheapest[0].total_minor >= best.total_minor:
        options.append(("best_fit", "Best fit · lowest price", best))
    else:
        options.append(("best_fit", "Best fit", best))
        budget = next((b for b in cheapest if _distinct_enough(b, [best])), None)
        if budget is not None:
            options.append(("budget_pick", "Budget pick", budget))
    chosen = [o[2] for o in options]
    by_variety = sorted(scored, key=lambda b: (-b.components["variety"].score, -b.total_score, b.total_minor, b.key))
    variety = next((b for b in by_variety if _distinct_enough(b, chosen)), None)
    if variety is not None:
        # Only claim "most variety" when it is measurably more varied than everything already shown.
        more_varied = all(variety.components["variety"].score > other.components["variety"].score + 0.01 for other in chosen)
        options.append(("most_variety", "Most variety" if more_varied else "Another good fit", variety))
    return options


# --------------------------------------------------------------------------- validation


@dataclass
class Problem:
    kind: str
    message: str
    sku: str | None = None
    available: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in {"kind": self.kind, "message": self.message, "sku": self.sku, "available": self.available}.items() if v is not None}


def validate_lines(
    lines: list[tuple[str, int]],
    items_by_sku: dict[str, CatalogItem],
    intent: Intent | None,
    *,
    max_units: int,
    slot_ends_at: datetime | None,
    require_portions: bool,
    ctx: PlanContext | None = None,
    tz_label=None,
) -> list[Problem]:
    """Validate an untrusted basket (LLM candidate, browse selection, or a quote being re-checked)."""
    problems: list[Problem] = []
    if not lines:
        return [Problem("empty", "The basket is empty")]
    merged: dict[str, int] = defaultdict(int)
    for sku, qty in lines:
        if not isinstance(qty, int) or qty <= 0:
            problems.append(Problem("invalid_quantity", f"Quantity for {sku} must be a positive whole number", sku))
            continue
        merged[sku] += qty
    total = 0
    servings = 0.0
    for sku, qty in merged.items():
        item = items_by_sku.get(sku)
        if item is None:
            problems.append(Problem("unknown_item", f"{sku} is not in this merchant's catalog", sku))
            continue
        if item.status != "active":
            problems.append(Problem("paused", f"{item.name} is no longer listed", sku, 0))
            continue
        if item.available < qty:
            kind = "sold_out" if item.available == 0 else "insufficient_stock"
            message = f"{item.name} sold out" if item.available == 0 else f"Only {item.available} {item.name} left"
            problems.append(Problem(kind, message, sku, item.available))
        if qty > item.per_order_limit:
            problems.append(Problem("over_item_limit", f"At most {item.per_order_limit} {item.name} per order", sku))
        if slot_ends_at is not None and item.cutoff_at < slot_ends_at:
            label = tz_label(item.cutoff_at) if tz_label else item.cutoff_at.isoformat()
            problems.append(Problem("cutoff", f"{item.name} must be picked up by {label}", sku))
        if intent is not None:
            dietary = check_dietary(item.allergens, item.attributes, intent)
            if not dietary.eligible:
                problems.append(Problem("dietary", f"{item.name}: {dietary.reasons[0]}", sku))
        total += qty * item.sale_minor
        servings += qty * item.servings
    units = sum(merged.values())
    if units > max_units:
        problems.append(Problem("over_order_limit", f"Orders are limited to {max_units} items"))
    if intent is not None and intent.budget_minor is not None and total > intent.budget_minor:
        problems.append(Problem("over_budget", "Basket total is above the budget"))
    if require_portions and ctx is not None and (servings + 1e-9 < ctx.min_servings or units < ctx.min_units):
        problems.append(Problem("too_small", f"Doesn't feed {ctx.party_size} people"))
    return problems


# --------------------------------------------------------------------------- pricing


def price_lines(lines: list[tuple[CatalogItem, int]], tax_rates_bps: dict[str, int], fees_minor: int = 0) -> dict[str, Any]:
    """Server-owned totals. Discount is reference minus sale; nothing is invented."""
    reference = sum(q * i.reference_minor for i, q in lines)
    subtotal = sum(q * i.sale_minor for i, q in lines)
    taxable: dict[str, int] = defaultdict(int)
    for item, qty in lines:
        taxable[item.tax_category] += qty * item.sale_minor
    tax = sum(apply_rate_bps(amount, int(tax_rates_bps.get(cat, 0))) for cat, amount in taxable.items())
    return {
        "reference_minor": reference,
        "subtotal_minor": subtotal,
        "discount_minor": reference - subtotal,
        "tax_minor": tax,
        "fees_minor": fees_minor,
        "total_minor": subtotal + tax + fees_minor,
    }


# --------------------------------------------------------------------------- explanations


def minimum_cost_for_party(eligible: list[CatalogItem], ctx: PlanContext) -> int | None:
    unconstrained = PlanContext(
        party_size=ctx.party_size,
        budget_minor=None,
        min_servings=ctx.min_servings,
        target_servings=ctx.target_servings,
        max_servings=ctx.max_servings,
        max_units=ctx.max_units,
        min_units=ctx.min_units,
        node_limit=ctx.node_limit,
        result_limit=ctx.result_limit,
    )
    bundles = enumerate_bundles(eligible, unconstrained)
    if not bundles:
        return None
    return min(sum(q * i.sale_minor for i, q in b) for b in bundles)


def exclusion_phrase(intent: Intent) -> str:
    labels = [ALLERGEN_LABELS[e.code] for e in intent.exclusions]
    labels += [d for d in intent.dietary]
    return ", ".join(labels)


def replacement_options(
    lines: list[tuple[CatalogItem, int]],
    shortfalls: dict[str, int],
    eligible: list[CatalogItem],
    intent: Intent | None,
    ctx: PlanContext | None,
    max_units: int,
    limit: int = 4,
) -> list[dict[str, Any]]:
    """Code-chosen replacement baskets for lines that can no longer be filled.

    ``shortfalls`` maps sku -> units that must be removed. Each option keeps every other
    line, removes the shortfall, and adds one eligible item that covers the lost servings
    within budget, stock and per-item limits. A "remove only" option is offered when the
    remaining basket still meets the party size.
    """
    by_sku = {i.sku: i for i, _ in lines}
    kept: dict[str, int] = {}
    lost_servings = 0.0
    removed_price = []
    for item, qty in lines:
        keep = qty - shortfalls.get(item.sku, 0)
        if keep > 0:
            kept[item.sku] = keep
        lost = qty - max(keep, 0)
        if lost > 0:
            lost_servings += lost * item.servings
            removed_price.append(item)
    kept_total = sum(by_sku[s].sale_minor * q for s, q in kept.items())
    kept_units = sum(kept.values())
    kept_servings = sum(by_sku[s].servings * q for s, q in kept.items())
    budget_left = None if intent is None or intent.budget_minor is None else intent.budget_minor - kept_total
    removed_categories = {i.category for i in removed_price}
    removed_flavors = {i.flavor for i in removed_price}
    ref_price = removed_price[0].sale_minor if removed_price else 1

    options: list[dict[str, Any]] = []
    for cand in eligible:
        if cand.sku in shortfalls:
            continue
        already = kept.get(cand.sku, 0)
        spare = min(cand.available - already, cand.per_order_limit - already)
        qty = max(1, math.ceil(lost_servings / cand.servings - 1e-9))
        if qty > spare or kept_units + qty > max_units:
            continue
        cost = qty * cand.sale_minor
        if budget_left is not None and cost > budget_left:
            continue
        similarity = (
            0.35 * (cand.category in removed_categories)
            + 0.30 * (cand.flavor in removed_flavors)
            + 0.20 * (1 - min(1.0, abs(cand.sale_minor - ref_price) / ref_price))
            + 0.15 * (cand.surplus_priority / 3)
        )
        revised = dict(kept)
        revised[cand.sku] = already + qty
        options.append(
            {
                "kind": "replace",
                "add_sku": cand.sku,
                "add_qty": qty,
                "lines": sorted(revised.items()),
                "similarity": round(similarity, 3),
                "cost_minor": cost,
            }
        )
    options.sort(key=lambda o: (-o["similarity"], o["cost_minor"], o["add_sku"]))
    options = options[:limit]
    meets_party = ctx is None or (kept_servings + 1e-9 >= ctx.min_servings and kept_units >= ctx.min_units)
    if kept and meets_party:
        options.append({"kind": "remove", "add_sku": None, "add_qty": 0, "lines": sorted(kept.items()), "similarity": 0, "cost_minor": 0})
    return options
