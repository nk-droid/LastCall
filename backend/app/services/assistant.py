"""The shop's AI teammates: what the close-out agent, Ask LastCall and Watch alerts did for this shop.

One feed for the last week, newest first, plus what shoppers asked for that the shop couldn't offer. Shoppers'
own words never appear here: Ask LastCall's checks are recorded as structured facts (party size, budget,
allergens, pickup time) and watches are described by their constraints. Outcomes (a bundle opened or ordered)
come from the quotes and orders that followed.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select

from app import clock
from app.db import transaction
from app.domain import ALLERGEN_LABELS
from app.models import AgentProposal, AnalyticsEvent, BundleQuote, Order, Watch, WatchMatch
from app.money import format_money
from app.services import closeout
from app.services.access import StaffContext
from app.services.catalog import merchant_by_id, policy

WINDOW_DAYS = 7
# Newest items per assistant (Ask LastCall's suggestions and passes count together), so a busy week of
# suggestions can't push close-out plans or watch alerts out of the feed.
FEED_PER_ASSISTANT = 15
PAID = "CAPTURED"


def activity(ctx: StaffContext) -> dict[str, Any]:
    with transaction() as db:
        merchant = merchant_by_id(db, ctx.merchant_id)
        tz, now = merchant.timezone, clock.now()
        today = clock.local_date(tz)
        day_start = clock.combine_local(today, "00:00", tz)
        since = clock.combine_local(today - timedelta(days=WINDOW_DAYS - 1), "00:00", tz)

        plans = db.scalars(select(AgentProposal).where(AgentProposal.kind == closeout.KIND, AgentProposal.merchant_id == merchant.id,
                                                       AgentProposal.created_at >= since, AgentProposal.status != "superseded")
                           .order_by(AgentProposal.created_at.desc())).all()
        events = db.scalars(select(AnalyticsEvent).where(AnalyticsEvent.merchant_id == merchant.id, AnalyticsEvent.created_at >= since,
                                                         AnalyticsEvent.event_name.in_(("concierge_checked", "concierge_suggested")))
                            .order_by(AnalyticsEvent.created_at.desc())).all()
        matches = db.scalars(select(WatchMatch).where(WatchMatch.merchant_id == merchant.id, WatchMatch.created_at >= since,
                                                      WatchMatch.email_message_id.is_not(None))).all()
        watches = {w.id: w for w in db.scalars(select(Watch).where(Watch.id.in_({m.watch_id for m in matches}))).all()} if matches else {}
        watching = db.scalar(select(func.count()).select_from(Watch).where(
            Watch.status == "active", Watch.expires_at > now, or_(Watch.merchant_id == merchant.id, Watch.merchant_id.is_(None)))) or 0
        outcome = _outcomes(db, events, matches)

        suggested = [e for e in events if e.event_name == "concierge_suggested"]
        suggested_convs = {e.properties.get("conversation_id") for e in suggested}
        skipped = _passed_on(events)

        feed: list[dict[str, Any]] = []
        for p in plans:
            feed.append(_plan_item(p, now))
        for e in suggested:
            props = e.properties
            status = outcome.get(("proposal", e.entity_id, props.get("option_key")))
            feed.append(_item(e.created_at, "concierge", "Ask LastCall suggested your bundle",
                              f"{_facts(props.get('request', {}), sep=' · ') or 'A shopper'} · {props.get('units')} items for "
                              f"{format_money(props.get('total_minor', 0), props.get('currency', 'USD'))}", status, f"suggested:{e.id}"))
        for e in skipped.values():
            req = e.properties.get("request", {})
            feed.append(_item(e.created_at, "concierge_skip", "Ask LastCall passed on your shop",
                              f"{_facts(req, sep=' · ') or 'A shopper'} · {_gap_reason(e.properties.get('gap', 'other'), req)}", None, f"skipped:{e.id}"))
        for m in matches:
            watch = watches.get(m.watch_id)
            facts = _facts(watch.constraints, sep=", ") if watch else ""
            status = outcome.get(("match", m.id, None)) or ({"tone": "info", "label": "Opened"} if m.opened_at else {"tone": "neutral", "label": "Not opened"})
            feed.append(_item(m.created_at, "watch", "Watch alert sent",
                              f"A shopper watching for {facts or 'deals'} got “{m.label}” for {format_money(m.total_minor, m.currency)}", status, f"watch:{m.id}"))
        feed.sort(key=lambda i: i["_at"], reverse=True)
        for item in feed:
            at = item.pop("_at")
            item["day"] = at.astimezone(ZoneInfo(tz)).date().isoformat()
            item["time_label"] = clock.display_time(at, tz)
        gaps = Counter(_gap_label(e.properties.get("gap", "other"), e.properties.get("request", {})) for e in skipped.values())

        # What came of it this week: suggestions that led to a paid order, alerts the shopper opened or bought from.
        ordered_suggestions = sum(1 for e in suggested
                                  if (outcome.get(("proposal", e.entity_id, e.properties.get("option_key"))) or {}).get("label") == "Ordered")
        alert_outcomes = [outcome.get(("match", m.id, None)) for m in matches]
        alerts_opened = sum(1 for m, result in zip(matches, alert_outcomes, strict=True) if m.opened_at or result)
        alerts_ordered = sum(1 for result in alert_outcomes if result and result.get("label") == "Ordered")

        today_plan = next((p for p in plans if p.subject_date == today.isoformat()), None)
        sched = closeout.schedule(merchant)
        return {
            "today": today.isoformat(),
            "teammates": {
                "closeout": {
                    "enabled": sched["enabled"],
                    "status": _plan_status(today_plan, now)["label"] if today_plan else None,
                    "waiting": bool(today_plan and _open(today_plan, now)),
                    "runs_at_label": sched["runs_at_label"],
                },
                "concierge": {
                    "listed": bool(policy(merchant, "concierge_listed", True)),
                    "suggested_today": len({e.properties.get("conversation_id") for e in suggested if e.created_at >= day_start}),
                    "suggested_week": len(suggested_convs),
                    "ordered_week": ordered_suggestions,
                },
                "watch": {"alerts_today": sum(1 for m in matches if m.created_at >= day_start), "alerts_week": len(matches), "watching": watching,
                          "opened_week": alerts_opened, "ordered_week": alerts_ordered},
            },
            "feed": _per_assistant(feed),
            "gaps": [{"label": label, "count": n} for label, n in gaps.most_common(5)],
            "policies": {"closeout_enabled": sched["enabled"], "concierge_listed": bool(policy(merchant, "concierge_listed", True))},
            "can_edit": ctx.role in ("manager", "owner"),
        }


# --------------------------------------------------------------------------- feed items


def _per_assistant(feed: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the newest FEED_PER_ASSISTANT items of each assistant; ``feed`` is already newest first."""
    seen: Counter[str] = Counter()
    kept = []
    for item in feed:
        owner = "concierge" if item["kind"].startswith("concierge") else item["kind"]
        if seen[owner] < FEED_PER_ASSISTANT:
            seen[owner] += 1
            kept.append(item)
    return kept


def _item(at, kind: str, title: str, detail: str, status: dict[str, str] | None, key: str, action: str | None = None) -> dict[str, Any]:
    return {"id": key, "kind": kind, "at": clock.iso(at), "_at": at, "title": title, "detail": detail, "status": status, "action": action}


def _open(plan: AgentProposal, now) -> bool:
    return plan.status in ("pending", "partly_applied") and plan.expires_at > now


def _plan_status(plan: AgentProposal, now) -> dict[str, str]:
    if _open(plan, now):
        return {"tone": "warning", "label": "Waiting for your OK" if plan.status == "pending" else "Partly applied"}
    if plan.status == "applied":
        changed = any(a.get("status") == "applied" for a in plan.actions)
        return {"tone": "success", "label": "Applied"} if changed else {"tone": "neutral", "label": "No changes needed"}
    if plan.status == "partly_applied":
        return {"tone": "success", "label": "Partly applied"}
    return {"tone": "neutral", "label": "Dismissed" if plan.status == "dismissed" else "Expired"}


def _plan_item(plan: AgentProposal, now) -> dict[str, Any]:
    kept = [a for a in plan.actions if a.get("status") != "dropped"]
    kinds = Counter("price" if a["type"] == "lower_price" else "slot" if "slot" in a["type"] else "listing" for a in kept)
    parts = [f"{n} {name}{'' if n == 1 else 's'}" for key, name in (("price", "price cut"), ("slot", "slot change"), ("listing", "listing change"))
             if (n := kinds.get(key))]
    detail = " and ".join([", ".join(parts[:-1]), parts[-1]] if len(parts) > 1 else parts) or "Nothing needed changing"
    if plan.source == "rules":
        detail += " · simple rules plan"
    return _item(plan.created_at, "closeout", "Close-out drafted a plan", detail, _plan_status(plan, now), f"plan:{plan.id}",
                 action="review" if _open(plan, now) else None)


def _passed_on(events: list[AnalyticsEvent]) -> dict[str, AnalyticsEvent]:
    """Ask LastCall checks where the shop had nothing to offer: once per conversation, and only if none of its
    bundles were shown in it. ``events`` are newest first, so each conversation keeps its latest check."""
    suggested_convs = {e.properties.get("conversation_id") for e in events if e.event_name == "concierge_suggested"}
    skipped: dict[str, AnalyticsEvent] = {}
    for e in events:
        conv = e.properties.get("conversation_id")
        if e.event_name == "concierge_checked" and not e.properties.get("options") and conv not in suggested_convs:
            skipped.setdefault(conv, e)
    return skipped


def missed_demand(db, merchant_id: str, since: datetime, until: datetime) -> dict[str, Any]:
    """What shoppers asked for that the shop couldn't offer, and who is waiting for its items (for Insights)."""
    events = db.scalars(select(AnalyticsEvent).where(AnalyticsEvent.merchant_id == merchant_id, AnalyticsEvent.created_at >= since,
                                                     AnalyticsEvent.created_at <= until,
                                                     AnalyticsEvent.event_name.in_(("concierge_checked", "concierge_suggested")))
                        .order_by(AnalyticsEvent.created_at.desc())).all()
    gaps = Counter(_gap_label(e.properties.get("gap", "other"), e.properties.get("request", {})) for e in _passed_on(events).values())
    matches = db.scalars(select(WatchMatch).where(WatchMatch.merchant_id == merchant_id, WatchMatch.created_at >= since,
                                                  WatchMatch.created_at <= until, WatchMatch.email_message_id.is_not(None))).all()
    outcome = _outcomes(db, [], matches)
    now = clock.now()
    watching = db.scalar(select(func.count()).select_from(Watch).where(
        Watch.status == "active", Watch.expires_at > now, or_(Watch.merchant_id == merchant_id, Watch.merchant_id.is_(None)))) or 0
    top = gaps.most_common(3)
    rest = sum(gaps.values()) - sum(n for _, n in top)
    return {
        "requests": [{"label": label, "count": n} for label, n in top] + ([{"label": "Other requests", "count": rest}] if rest else []),
        "total": sum(gaps.values()),
        "watching": watching,
        "alerts": len(matches),
        "alerts_ordered": sum(1 for m in matches if (outcome.get(("match", m.id, None)) or {}).get("label") == "Ordered"),
    }


def _outcomes(db, events: list[AnalyticsEvent], matches: list[WatchMatch]) -> dict[tuple[str, str, str | None], dict[str, str]]:
    """Whether a suggested bundle or a watch alert led to a held checkout or a paid order."""
    proposal_ids = [e.entity_id for e in events if e.event_name == "concierge_suggested" and e.entity_id]
    quote_ids = [m.quote_id for m in matches if m.quote_id]
    if not proposal_ids and not quote_ids:
        return {}
    quotes = db.scalars(select(BundleQuote).where(or_(BundleQuote.proposal_id.in_(proposal_ids), BundleQuote.id.in_(quote_ids)))).all()
    # A quote can be re-priced into a new version; any version in the lineage that was paid counts.
    lineages = {q.lineage_id for q in quotes}
    paid_lineages = set(db.scalars(select(BundleQuote.lineage_id).join(Order, Order.quote_id == BundleQuote.id)
                                   .where(BundleQuote.lineage_id.in_(lineages), Order.payment_status == PAID)).all()) if lineages else set()
    out: dict[tuple[str, str, str | None], dict[str, str]] = {}
    ordered, opened = {"tone": "success", "label": "Ordered"}, {"tone": "info", "label": "Opened"}
    for q in quotes:
        result = ordered if q.lineage_id in paid_lineages else opened
        if q.proposal_id:
            key = ("proposal", q.proposal_id, q.option_id)
            if out.get(key) is not ordered:
                out[key] = result
    for m in matches:
        lineage = next((q.lineage_id for q in quotes if q.id == m.quote_id), None)
        if lineage:
            out[("match", m.id, None)] = ordered if lineage in paid_lineages else opened
    return out


# --------------------------------------------------------------------------- request facts


def _clock(hhmm: str) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    return f"{h % 12 or 12}{f':{m:02d}' if m else ''} {'AM' if h < 12 else 'PM'}"


def _facts(req: dict[str, Any], *, sep: str) -> str:
    facts = []
    if req.get("party_size"):
        facts.append(f"{req['party_size']} {'person' if req['party_size'] == 1 else 'people'}")
    if req.get("budget_minor"):
        facts.append(f"under {format_money(req['budget_minor'], req.get('currency', 'USD'))}")
    codes = [e if isinstance(e, str) else e.get("code") for e in req.get("exclusions", [])]
    if codes:
        facts.append("no " + " or ".join(ALLERGEN_LABELS.get(c, c) for c in codes))
    facts += list(req.get("dietary", []))
    if req.get("pickup_window"):
        start, end = req["pickup_window"]
        facts.append(f"pickup {_clock(start)}–{_clock(end)}")
    return sep.join(facts)


def _allergens(req: dict[str, Any]) -> str:
    codes = [e if isinstance(e, str) else e.get("code") for e in req.get("exclusions", [])]
    return " and ".join(ALLERGEN_LABELS.get(c, c) for c in codes)


def _gap_reason(gap: str, req: dict[str, Any]) -> str:
    if gap == "dietary":
        diet = " or ".join(req.get("dietary", []))
        return f"nothing verified free of {_allergens(req)}" if _allergens(req) else f"nothing marked {diet or 'for their diet'}"
    return {
        "pickup": "no pickup slots at that time",
        "no_surplus": "nothing was listed",
        "servings": f"not enough left for {req.get('party_size')} people",
        "budget": "nothing fit the budget",
    }.get(gap, "nothing fit every need")


def _gap_label(gap: str, req: dict[str, Any]) -> str:
    if gap == "dietary":
        if _allergens(req):
            return f"Free of {_allergens(req)}"
        return f"{' and '.join(d.capitalize() for d in req.get('dietary', [])) or 'Dietary'} options"
    if gap == "pickup" and req.get("pickup_window"):
        start, end = req["pickup_window"]
        return f"Pickup {_clock(start)}–{_clock(end)}"
    return {
        "pickup": "Other pickup times",
        "no_surplus": "Surplus listed at the time",
        "servings": f"Food for {req.get('party_size')}+ people",
        "budget": f"Bundles under {format_money(req['budget_minor'], req.get('currency', 'USD'))}" if req.get("budget_minor") else "Lower prices",
    }.get(gap, "Other combinations")
