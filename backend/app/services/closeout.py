"""A3 Close-out agent: before pickup ends, an agent proposes end-of-day changes and a manager approves them.

``closeout.plan`` runs every five minutes and, once per shop per day, starts a plan ``closeout_lead_minutes``
(default 60) before the shop's last pickup window ends; a manager can also press Run now. The agent reads
today's stock, pickup slots and sales through read-only tools and proposes actions from a fixed set:

    adjust_surplus, lower_price, pause_listing, resume_listing, close_slot, reopen_slot, set_slot_capacity

Code checks every action against hard bounds before anyone sees it, and again when it is applied:
prices only go down and never below ``FLOOR_PERCENT`` of the regular price (the reference price is never
touched, so savings stay honest); surplus never drops below held + paid units and only grows into stock the
shop counted but didn't list; slots with bookings are never closed or cut below their bookings. Actions that
fail a bound are kept as "dropped" with the reason.

Applying runs the existing service functions (``update_inventory``, ``set_price``, ``pickup.update_slot``) as
the approving manager, so the result is exactly what doing it by hand would be (shoppers with open quotes
are asked to re-approve a new price, held quotes keep theirs). An action whose product changed since the plan
was made is skipped. The audit log records the plan, the agent run and who approved it. With the model off,
a simple rules plan (discount slow sellers) is offered instead. Plans expire when pickup ends.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app import clock
from app.ai import prompts
from app.ai.agent import Tool, run_agent
from app.ai.sanitize import clean_customer_prose
from app.db import transaction
from app.errors import AppError, Conflict, NotFound, Unprocessable
from app.ids import new_id
from app.models import AgentProposal, InventoryEvent, Merchant
from app.money import format_money
from app.services import audit, insights, inventory, jobs, pickup
from app.services.access import StaffContext, require_role
from app.services.alerts import raise_alert, resolve_alerts
from app.services.catalog import list_merchants, merchant_by_id, policy

log = logging.getLogger(__name__)

KIND = "closeout"
FLOOR_PERCENT = 30
MAX_ACTIONS = 6
MAX_DELTA = 50
ActionType = Literal["adjust_surplus", "lower_price", "pause_listing", "resume_listing", "close_slot", "reopen_slot", "set_slot_capacity"]
PRODUCT_ACTIONS = {"adjust_surplus", "lower_price", "pause_listing", "resume_listing"}


# --------------------------------------------------------------------------- tool contracts


class NoArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")


class PlanAction(BaseModel):
    type: ActionType
    sku: str | None = Field(default=None, max_length=32, description="For product actions")
    slot_id: str | None = Field(default=None, max_length=40, description="For slot actions")
    delta: int | None = Field(default=None, ge=-MAX_DELTA, le=MAX_DELTA, description="adjust_surplus: units to add (+) or remove (-)")
    new_price_dollars: float | None = Field(default=None, gt=0, le=1000, description="lower_price: the new price in dollars")
    capacity: int | None = Field(default=None, ge=0, le=100, description="set_slot_capacity: the new capacity")
    reason: str = Field(default="", max_length=240)


class ProposePlanArgs(BaseModel):
    summary: str = Field(default="", max_length=400)
    actions: list[PlanAction] = Field(default_factory=list, max_length=12)


# --------------------------------------------------------------------------- schedule


def close_at(merchant: Merchant, now: datetime | None = None) -> datetime | None:
    """When today's last pickup window ends (23:59 for a shop open around the clock), or None if no pickup today."""
    day = clock.local_date(merchant.timezone)
    window = pickup.window_for(merchant, day)
    return clock.combine_local(day, window[1], merchant.timezone) if window else None


def schedule(merchant: Merchant) -> dict[str, Any]:
    end = close_at(merchant)
    lead = int(policy(merchant, "closeout_lead_minutes", 60))
    return {
        "enabled": bool(policy(merchant, "closeout_enabled", True)),
        "lead_minutes": lead,
        "runs_at": clock.iso(end - timedelta(minutes=lead)) if end else None,
        "runs_at_label": clock.display_time(end - timedelta(minutes=lead), merchant.timezone) if end else None,
        "closes_at_label": clock.display_time(end, merchant.timezone) if end else None,
    }


@jobs.handler("closeout.plan", every=300)
def _plan_due(_: dict[str, Any]) -> dict[str, Any]:
    return run_due()


def run_due() -> dict[str, Any]:
    """Expire finished plans, then start today's plan for every shop that has reached its lead time."""
    now = clock.now()
    started = 0
    with transaction() as db:
        for row in db.scalars(select(AgentProposal).where(AgentProposal.kind == KIND, AgentProposal.status.in_(("pending", "partly_applied")),
                                                          AgentProposal.expires_at <= now)).all():
            row.status = "expired"
            resolve_alerts(db, row.merchant_id, "closeout_ready", row.id)
        merchants = list_merchants(db)
        for m in merchants:
            db.expunge(m)
    for merchant in merchants:
        if not policy(merchant, "closeout_enabled", True):
            continue
        end = close_at(merchant, now)
        if end is None or not (end - timedelta(minutes=int(policy(merchant, "closeout_lead_minutes", 60))) <= now < end):
            continue
        today = clock.local_date(merchant.timezone).isoformat()
        with transaction() as db:
            exists = db.scalar(select(AgentProposal.id).where(AgentProposal.kind == KIND, AgentProposal.merchant_id == merchant.id,
                                                              AgentProposal.subject_date == today))
        if exists:
            continue
        try:
            generate(merchant.id, actor="system:closeout")
            started += 1
        except Exception:  # one shop must not stop the others
            log.exception("close-out plan failed", extra={"merchant_id": merchant.id})
    return {"started": started}


# --------------------------------------------------------------------------- planning


def generate(merchant_id: str, *, actor: str) -> dict[str, Any]:
    """Make today's plan (replacing any undecided one) and raise a Needs attention item if it suggests anything."""
    with transaction() as db:
        merchant = merchant_by_id(db, merchant_id)
        db.expunge(merchant)
    end = close_at(merchant)
    if end is None:
        raise Unprocessable("There's no pickup today, so there's nothing to close out", code="no_pickup_today")
    snap = _snapshot(merchant)
    state: dict[str, Any] = {"merchant": merchant, "snapshot": snap}
    result = run_agent(
        kind=KIND, prompt_version=prompts.CLOSEOUT_PROMPT_VERSION, system=prompts.CLOSEOUT_SYSTEM,
        messages=[{"role": "user", "content": f"Make today's close-out plan for {merchant.name}. Pickup ends at {clock.display_time(end, merchant.timezone)}."}],
        # Low thinking keeps Run now to about ten seconds; the plan is still checked by code either way.
        tools=_tools(), subject=("merchant", merchant.id), state=state, timeout=90, turn_timeout=60, think="low",
    )
    if result.ok and isinstance(result.final, ProposePlanArgs):
        raw, summary, source = result.final.actions, result.final.summary, "agent"
    else:
        raw, summary, source = _rules_plan(snap, merchant), "", "rules"
    actions = _check(raw, snap, merchant)
    proposed = [a for a in actions if a["status"] == "proposed"]
    summary = clean_customer_prose(summary, allowed_amounts=set(), max_chars=300) if summary else ""
    if not summary:
        summary = (f"{len(proposed)} change{'s' if len(proposed) != 1 else ''} to help clear today's surplus before pickup ends."
                   if proposed else "Nothing needs changing before close.")
    today = clock.local_date(merchant.timezone).isoformat()
    with transaction() as db:
        for old in db.scalars(select(AgentProposal).where(AgentProposal.kind == KIND, AgentProposal.merchant_id == merchant.id,
                                                          AgentProposal.subject_date == today, AgentProposal.status == "pending")).all():
            old.status = "superseded"
            resolve_alerts(db, merchant.id, "closeout_ready", old.id)
        plan = AgentProposal(id=new_id("prp_co"), kind=KIND, merchant_id=merchant.id, run_id=result.run_id, subject_date=today,
                             status="pending" if proposed else "applied", source=source, summary=summary, actions=actions,
                             created_by=actor[:120], expires_at=end)
        db.add(plan)
        if proposed:
            raise_alert(db, merchant.id, "closeout_ready", "proposal", plan.id,
                        f"Close-out plan ready: {len(proposed)} suggested change{'s' if len(proposed) != 1 else ''} before pickup ends", severity="medium")
        audit.record(db, actor=actor[:120], actor_role="system" if actor.startswith("system") else "staff", entity_type="proposal",
                     entity_id=plan.id, action="closeout_planned",
                     meta={"source": source, "agent_run_id": result.run_id, "proposed": len(proposed), "dropped": len(actions) - len(proposed)})
        db.flush()
        return view(merchant, plan)


def _tools() -> list[Tool]:
    return [
        Tool("get_stock", "Today's listed products: listed, available, held and paid units, current and regular price, the lowest price "
             "allowed, and whether the price already changed today.", NoArgs, _get_stock),
        Tool("get_pickup_slots", "Today's remaining pickup slots with capacity, bookings and status.", NoArgs, _get_slots),
        Tool("get_today_sales", "Today's units listed, sold and remaining, and surplus sell-through so far.", NoArgs, _get_sales),
        Tool("propose_plan", "Propose the close-out plan (a manager approves it before anything changes). Ends your turn.", ProposePlanArgs, final=True),
    ]


def _get_stock(ctx, args: NoArgs) -> dict[str, Any]:
    snap = ctx.state["snapshot"]
    cur = ctx.state["merchant"].currency
    products = []
    for p in snap["products"].values():
        products.append({
            "sku": p["sku"], "name": p["name"], "category": p["category"], "status": p["status"], "listed": p["surplus"], "on_hand": p["on_hand"],
            "available": p["available"], "held": p["reserved"], "paid": p["committed"],
            "price": format_money(p["sale_minor"], cur) if p["sale_minor"] else None,
            "regular_price": format_money(p["reference_minor"], cur) if p["reference_minor"] else None,
            "lowest_allowed_price": format_money(p["floor_minor"], cur) if p["floor_minor"] else None,
            "price_changed_today": p["price_changed_today"], "sell_by": p["cutoff_label"],
        })
    return {"pickup_ends": snap["closes_label"], "minutes_left": snap["minutes_left"], "products": products}


def _get_slots(ctx, args: NoArgs) -> dict[str, Any]:
    return {"slots": [{"slot_id": s["id"], "time": s["label"], "capacity": s["capacity"], "booked": s["booked"], "status": s["status"]}
                      for s in ctx.state["snapshot"]["slots"].values()]}


def _get_sales(ctx, args: NoArgs) -> dict[str, Any]:
    m = insights.compute(ctx.state["merchant"].id, "today")
    sell = m["metrics"]["surplus_sell_through"]["value"]
    return {"units": m["units"], "surplus_sell_through": None if sell is None else f"{round(sell * 100)}%",
            "minutes_left": ctx.state["snapshot"]["minutes_left"]}


def _snapshot(merchant: Merchant) -> dict[str, Any]:
    """Current products and today's not-yet-started slots, keyed for checking actions."""
    now = clock.now()
    today = clock.local_date(merchant.timezone)
    day_start = clock.combine_local(today, "00:00", merchant.timezone)
    with transaction() as db:
        rows = inventory.inventory_rows(db, merchant, now)
        # A real price change today (not the price the product was created with) rules out another one.
        repriced = set(db.scalars(select(InventoryEvent.product_id).where(InventoryEvent.merchant_id == merchant.id,
                                                                         InventoryEvent.event_type == "PRICE_CHANGED",
                                                                         InventoryEvent.created_at >= day_start)).all())
        pickup.ensure_slots(db, merchant, now)
        slots = [s for s in pickup.list_slots(db, merchant, now)
                 if s.starts_at > now and s.starts_at.astimezone(ZoneInfo(merchant.timezone)).date() == today]
        slot_rows = {}
        for s in slots:
            v = pickup.slot_view(s, merchant, now)
            slot_rows[s.id] = {**v, "status": s.status}
    products = {}
    for r in rows:
        if r["status"] == "archived":
            continue
        price = r.get("price") or {}
        changed_today = r["product_id"] in repriced
        reference = price.get("reference_minor") or 0
        products[r["sku"]] = {
            "product_id": r["product_id"], "sku": r["sku"], "name": r["name"], "category": r["category"], "status": r["status"],
            "surplus": r["surplus"], "on_hand": r["on_hand"], "available": r["available"], "reserved": r["reserved"], "committed": r["committed"],
            "version": r["version"], "sale_minor": price.get("sale_minor"), "reference_minor": reference or None,
            "reference_source": price.get("reference_source"), "floor_minor": math.ceil(reference * FLOOR_PERCENT / 100) if reference else None,
            "price_changed_today": changed_today, "cutoff_label": r.get("cutoff_label"),
        }
    end = close_at(merchant, now)
    return {"products": products, "slots": slot_rows, "closes_label": clock.display_time(end, merchant.timezone) if end else None,
            "minutes_left": max(0, int((end - now).total_seconds() // 60)) if end else 0}


def _rules_plan(snap: dict[str, Any], merchant: Merchant) -> list[PlanAction]:
    """No model: take 20% off items that have sold under 40% of what was listed, within the price floor."""
    plan = []
    for p in sorted(snap["products"].values(), key=lambda p: p["available"], reverse=True):
        if p["status"] != "active" or not p["sale_minor"] or p["price_changed_today"] or p["surplus"] < 3 or p["available"] < 3:
            continue
        sold_share = (p["surplus"] - p["available"]) / p["surplus"]
        if sold_share >= 0.4:
            continue
        target = max(p["floor_minor"] or 1, int(round(p["sale_minor"] * 0.8 / 25) * 25))
        if target >= p["sale_minor"]:
            continue
        plan.append(PlanAction(type="lower_price", sku=p["sku"], new_price_dollars=target / 100,
                               reason=f"{p['available']} of {p['surplus']} still available with {snap['minutes_left']} minutes left"))
    return plan[:MAX_ACTIONS]


def _check(raw: list[PlanAction], snap: dict[str, Any], merchant: Merchant) -> list[dict[str, Any]]:
    """Turn proposed actions into reviewable items, dropping (with a reason) any that break a bound."""
    out: list[dict[str, Any]] = []
    touched: set[tuple[str, str]] = set()
    cur = merchant.currency
    for idx, action in enumerate(raw, start=1):
        item: dict[str, Any] = {"id": f"a{idx}", "type": action.type, "reason": action.reason.strip()[:240], "status": "proposed"}
        try:
            if action.type in PRODUCT_ACTIONS:
                p = snap["products"].get(action.sku or "")
                if p is None:
                    raise _Drop("No such product")
                key = ("price" if action.type == "lower_price" else "stock", p["sku"])
                if key in touched:
                    raise _Drop("Only one change of this kind per item")
                item.update({"sku": p["sku"], "product_id": p["product_id"], "name": p["name"], "version": p["version"]})
                _check_product(action, p, item, cur)
                touched.add(key)
            else:
                s = snap["slots"].get(action.slot_id or "")
                if s is None:
                    raise _Drop("No such upcoming slot today")
                if ("slot", s["id"]) in touched:
                    raise _Drop("Only one change per slot")
                item.update({"slot_id": s["id"], "slot_label": s["label"], "booked": s["booked"]})
                _check_slot(action, s, item)
                touched.add(("slot", s["id"]))
        except _Drop as drop:
            item["status"] = "dropped"
            item["note"] = str(drop)
        out.append(item)
    kept = 0
    for item in out:  # keep the first few the agent ranked highest
        if item["status"] == "proposed":
            kept += 1
            if kept > MAX_ACTIONS:
                item["status"], item["note"] = "dropped", f"More than {MAX_ACTIONS} changes"
    return out


class _Drop(Exception):
    pass


def _check_product(action: PlanAction, p: dict[str, Any], item: dict[str, Any], cur: str) -> None:
    held = p["reserved"] + p["committed"]
    if action.type == "adjust_surplus":
        if not action.delta:
            raise _Drop("No change in units")
        new = p["surplus"] + action.delta
        if new < held:
            raise _Drop(f"Can't go below {held} held or paid unit(s)")
        if action.delta > 0 and new > p["on_hand"]:
            raise _Drop(f"Only {p['on_hand']} on hand; LastCall never lists stock the shop didn't count")
        item.update({"delta": action.delta, "title": f"{'List' if action.delta > 0 else 'Remove'} {abs(action.delta)} {p['name']}",
                     "before": f"{p['surplus']} listed", "after": f"{new} listed"})
    elif action.type == "lower_price":
        if p["status"] != "active" or not p["sale_minor"]:
            raise _Drop("Not on sale right now")
        if p["price_changed_today"]:
            raise _Drop("Price already changed today")
        new = int(round((action.new_price_dollars or 0) * 100))
        if new >= p["sale_minor"]:
            raise _Drop("The close-out plan only lowers prices")
        if new < (p["floor_minor"] or 0):
            raise _Drop(f"Below the lowest allowed price ({format_money(p['floor_minor'], cur)}, {FLOOR_PERCENT}% of the regular price)")
        item.update({"new_sale_minor": new, "title": f"Lower {p['name']} to {format_money(new, cur)}",
                     "before": format_money(p["sale_minor"], cur), "after": format_money(new, cur)})
    elif action.type == "pause_listing":
        if p["status"] != "active":
            raise _Drop("Already paused")
        item.update({"title": f"Pause {p['name']}", "before": "On sale", "after": "Paused"})
    elif action.type == "resume_listing":
        if p["status"] != "paused":
            raise _Drop("Already on sale")
        item.update({"title": f"Resume {p['name']}", "before": "Paused", "after": "On sale"})


def _check_slot(action: PlanAction, s: dict[str, Any], item: dict[str, Any]) -> None:
    if action.type == "close_slot":
        if s["status"] != "open":
            raise _Drop("Already closed")
        if s["booked"]:
            raise _Drop(f"Has {s['booked']} booking(s)")
        item.update({"title": f"Close the {s['label']} slot", "before": "Open", "after": "Closed"})
    elif action.type == "reopen_slot":
        if s["status"] == "open":
            raise _Drop("Already open")
        item.update({"title": f"Reopen the {s['label']} slot", "before": "Closed", "after": "Open"})
    elif action.type == "set_slot_capacity":
        if action.capacity is None or action.capacity == s["capacity"]:
            raise _Drop("No change in capacity")
        if action.capacity < s["booked"]:
            raise _Drop(f"Can't go below its {s['booked']} booking(s)")
        item.update({"capacity": action.capacity, "title": f"Set the {s['label']} slot to {action.capacity} pickups",
                     "before": f"{s['capacity']} pickups", "after": f"{action.capacity} pickups"})


# --------------------------------------------------------------------------- manager actions


def current(ctx: StaffContext) -> dict[str, Any]:
    with transaction() as db:
        merchant = merchant_by_id(db, ctx.merchant_id)
        today = clock.local_date(merchant.timezone).isoformat()
        plan = db.scalars(select(AgentProposal).where(AgentProposal.kind == KIND, AgentProposal.merchant_id == merchant.id,
                                                      AgentProposal.subject_date == today, AgentProposal.status != "superseded")
                          .order_by(AgentProposal.created_at.desc())).first()
        return {"plan": view(merchant, plan) if plan else None, "schedule": schedule(merchant), "can_apply": ctx.role in ("manager", "owner")}


def run_now(ctx: StaffContext) -> dict[str, Any]:
    require_role(ctx, "manager")
    return generate(ctx.merchant_id, actor=ctx.actor)


def apply(ctx: StaffContext, plan_id: str, action_ids: list[str] | None = None) -> dict[str, Any]:
    require_role(ctx, "manager")
    with transaction() as db:
        plan = db.get(AgentProposal, plan_id)
        if plan is None or plan.merchant_id != ctx.merchant_id or plan.kind != KIND:
            raise NotFound("Plan not found", code="plan_missing")
        if plan.status not in ("pending", "partly_applied"):
            raise Conflict(f"This plan was already {plan.status.replace('_', ' ')}", code="plan_closed")
        if plan.expires_at <= clock.now():
            raise Conflict("Pickup has ended, so this plan expired", code="plan_expired")
        merchant = merchant_by_id(db, ctx.merchant_id)
        db.expunge(merchant)
        actions = [dict(a) for a in plan.actions]
        run_id = plan.run_id
    chosen = set(action_ids) if action_ids else {a["id"] for a in actions}
    snap = _snapshot(merchant)
    for item in actions:
        if item["id"] not in chosen or item["status"] != "proposed":
            continue
        try:
            _apply_one(ctx, merchant, item, snap)
            item["status"] = "applied"
        except _Skip as skip:
            item["status"], item["note"] = "skipped", str(skip)
        except AppError as exc:
            item["status"], item["note"] = "failed", exc.message
        snap = _snapshot(merchant)  # each change can affect the next one's bounds
    left = [a for a in actions if a["status"] == "proposed"]
    with transaction() as db:
        plan = db.get(AgentProposal, plan_id, with_for_update=True)
        plan.actions = actions
        plan.status = "partly_applied" if left else "applied"
        plan.decided_by = ctx.actor
        plan.decided_at = clock.now()
        if not left:
            resolve_alerts(db, merchant.id, "closeout_ready", plan.id)
        audit.record(db, actor="agent:closeout", actor_role="agent", entity_type="proposal", entity_id=plan.id, action="closeout_applied",
                     meta={"approved_by": ctx.actor, "agent_run_id": run_id,
                           "applied": [a["id"] for a in actions if a["status"] == "applied"],
                           "skipped": [{"id": a["id"], "note": a.get("note")} for a in actions if a["status"] in ("skipped", "failed")]})
        db.flush()
        return view(merchant, plan)


def dismiss(ctx: StaffContext, plan_id: str) -> dict[str, Any]:
    require_role(ctx, "manager")
    with transaction() as db:
        plan = db.get(AgentProposal, plan_id, with_for_update=True)
        if plan is None or plan.merchant_id != ctx.merchant_id or plan.kind != KIND:
            raise NotFound("Plan not found", code="plan_missing")
        if plan.status not in ("pending", "partly_applied"):
            raise Conflict(f"This plan was already {plan.status.replace('_', ' ')}", code="plan_closed")
        plan.status = "dismissed"
        plan.decided_by = ctx.actor
        plan.decided_at = clock.now()
        resolve_alerts(db, plan.merchant_id, "closeout_ready", plan.id)
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="proposal", entity_id=plan.id, action="closeout_dismissed", meta={})
        merchant = merchant_by_id(db, ctx.merchant_id)
        return view(merchant, plan)


class _Skip(Exception):
    pass


def _apply_one(ctx: StaffContext, merchant: Merchant, item: dict[str, Any], snap: dict[str, Any]) -> None:
    """Re-check against current state, then make the change through the same service a person would use."""
    reason = f"Close-out plan: {item.get('reason') or item['type'].replace('_', ' ')}"[:200]
    if item["type"] in PRODUCT_ACTIONS:
        p = snap["products"].get(item["sku"])
        if p is None or p["version"] != item["version"]:
            raise _Skip("Changed since the plan was made")
        action = PlanAction(type=item["type"], sku=item["sku"], delta=item.get("delta"),
                            new_price_dollars=(item["new_sale_minor"] / 100) if item.get("new_sale_minor") else None)
        try:
            _check_product(action, p, {}, merchant.currency)
        except _Drop as drop:
            raise _Skip(str(drop)) from None
        if item["type"] == "lower_price":
            inventory.set_price(ctx, p["product_id"], inventory.PriceInput(reference_minor=p["reference_minor"], sale_minor=item["new_sale_minor"],
                                                                         reference_source=p["reference_source"]))
        else:
            kind = {"adjust_surplus": "adjust", "pause_listing": "pause", "resume_listing": "resume"}[item["type"]]
            inventory.update_inventory(ctx, inventory.InventoryUpdate(product_id=p["product_id"], action=kind, delta=item.get("delta"),
                                                                      expected_version=p["version"], reason=reason))
        return
    s = snap["slots"].get(item["slot_id"])
    if s is None:
        raise _Skip("That slot has started or is gone")
    try:
        _check_slot(PlanAction(type=item["type"], slot_id=item["slot_id"], capacity=item.get("capacity")), s, {})
    except _Drop as drop:
        raise _Skip(str(drop)) from None
    status = {"close_slot": "closed", "reopen_slot": "open"}.get(item["type"])
    with transaction() as db:
        slot = pickup.update_slot(db, merchant, item["slot_id"], item.get("capacity"), status)
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="pickup_slot", entity_id=slot.id, action="slot_updated",
                     meta={"capacity": slot.capacity, "status": slot.status, "booked": slot.booked_count, "via": "closeout_plan"})


def view(merchant: Merchant, plan: AgentProposal) -> dict[str, Any]:
    return {
        "id": plan.id, "status": plan.status, "source": plan.source, "summary": plan.summary, "actions": plan.actions,
        "created_by": plan.created_by, "decided_by": plan.decided_by, "created_at": clock.iso(plan.created_at),
        "expires_at": clock.iso(plan.expires_at), "expires_label": clock.display_time(plan.expires_at, merchant.timezone), "run_id": plan.run_id,
    }
