"""A2 Watch for me: a signed-in shopper's standing request, checked whenever shops list surplus.

Creating a watch parses the request once (the same L1 + rules parser as the build page) and stores the
structured fields. ``watches.scan`` runs every two minutes and right after a shop relists or adds stock.
For each active watch, code finds bundles with the bundle engine's own checks (party size, budget,
allergens, dietary needs, pickup time). A one-step agent only judges what code can't, such as "is this
the croissant box they asked for", and writes a one-line summary. The shopper then gets at most one email
per watch per day, never twice for the same bundle.

Nothing is held when the email goes out. Opening the link runs the normal flow for that browser:
parse → proposal → quote, then the review page holds the stock. If the bundle has sold out, the best
current option is offered instead.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from app import clock
from app.ai import prompts
from app.ai.agent import Tool, run_agent
from app.ai.sanitize import clean_customer_prose
from app.db import transaction
from app.domain import Exclusion, Intent
from app.errors import Conflict, NotFound, Unprocessable
from app.ids import new_id
from app.models import Conversation, Merchant, Product, User, Watch, WatchMatch
from app.money import format_money
from app.observability import redact
from app.services import intent as intent_service
from app.services import jobs, mail, quotes, recommendation
from app.services.accounts import SessionUser
from app.services.catalog import get_merchant, list_merchants

log = logging.getLogger(__name__)

MAX_ACTIVE = 5
LIFETIME = timedelta(days=7)
ALERT_DAYS = 14
ALERT_LIMIT = 20
QUIET = timedelta(hours=24)  # at most one email per watch per day
KEEP_ENDED = timedelta(days=30)
SCAN_LIMIT = 500
SCAN_KIND = "watches.scan"


CANDIDATES = 4  # bundles the judge chooses from per watch per scan
PER_SHOP = 2


class NotifyArgs(BaseModel):
    pick: str | None = Field(default=None, description="The candidate id to email the shopper about, or null if none is what they asked for")
    summary: str = Field(default="", max_length=300, description="One sentence on why the picked bundle fits")


@dataclass
class _Candidate:
    id: str
    merchant: Merchant
    opt: dict[str, Any]
    sig: str

    @property
    def items(self) -> list[str]:
        return [f"{ln['qty']} × {ln['name']}" for ln in self.opt["lines"]]

    @property
    def pickup_label(self) -> str:
        return self.opt["pickup_slots"][0]["label"] if self.opt.get("pickup_slots") else ""

    @property
    def total(self) -> str:
        return format_money(self.opt["totals"]["total_minor"], self.opt["totals"]["currency"])


# --------------------------------------------------------------------------- shopper actions


def create(user: SessionUser, session_id: str, *, text: str | None = None, shop: str | None = None,
           conversation_id: str | None = None) -> dict[str, Any]:
    """Save a watch from typed text, or from a concierge conversation (its shopper messages and shop)."""
    if conversation_id:
        with transaction() as db:
            conv = db.get(Conversation, conversation_id)
            if conv is None or conv.session_id != session_id:
                raise NotFound("We couldn't find that conversation", code="conversation_missing")
            text = " ".join(m["text"] for m in conv.messages if m["role"] == "user")[-600:]
            shop = db.get(Merchant, conv.scope_merchant_id).slug if conv.scope_merchant_id else shop
    text = redact(re.sub(r"\s+", " ", text or "").strip())[:600]
    if not text:
        raise Unprocessable("Describe what you'd like us to watch for", code="watch_text_required")
    with transaction() as db:
        active = db.scalar(select(func.count()).select_from(Watch).where(Watch.user_id == user.user_id, Watch.status.in_(("active", "paused"))))
        if active >= MAX_ACTIVE:
            raise Conflict(f"You can watch up to {MAX_ACTIVE} requests at once. Stop one to add another.", code="watch_limit")
        if shop:
            merchant = get_merchant(db, shop)
        else:
            live = list_merchants(db)
            if not live:
                raise Unprocessable("No shops are live yet", code="no_shops")
            merchant = live[0]
        merchant_id, slug = (merchant.id if shop else None), merchant.slug
    parsed, _ = intent_service.parse(intent_service.ParseRequest(merchant=slug, text=text, use_ai=True, persist=False), session_id)
    if parsed.intent.party_size is None:
        raise Unprocessable("Say how many people it's for, e.g. “croissants for 4 under $12”", code="party_size_required")
    constraints = parsed.intent.model_dump(mode="json")
    constraints.pop("pickup_date", None)  # a watch applies to whichever day a shop lists
    with transaction() as db:
        watch = Watch(id=new_id("wch"), user_id=user.user_id, merchant_id=merchant_id, text_redacted=text, constraints=constraints,
                      status="active", stop_token=secrets.token_urlsafe(24), expires_at=clock.now() + LIFETIME)
        db.add(watch)
        db.flush()
        result = _view(db, watch)
    jobs.enqueue(SCAN_KIND, {"watch_id": result["id"]}, delay_seconds=2)  # something may already fit
    return result


def list_for(user: SessionUser) -> dict[str, Any]:
    with transaction() as db:
        rows = db.scalars(select(Watch).where(Watch.user_id == user.user_id, Watch.status != "stopped").order_by(Watch.created_at.desc())).all()
        return {"watches": [_view(db, w) for w in rows], "limit": MAX_ACTIVE}


def set_status(user: SessionUser, watch_id: str, status: str) -> dict[str, Any]:
    with transaction() as db:
        watch = db.get(Watch, watch_id, with_for_update=True)
        if watch is None or watch.user_id != user.user_id or watch.status == "stopped":
            raise NotFound("Watch not found", code="watch_missing")
        if status == "active" and watch.status == "expired":
            watch.expires_at = clock.now() + LIFETIME
        watch.status = status
        return _view(db, watch)


def stop_by_token(token: str) -> dict[str, Any]:
    with transaction() as db:
        watch = db.scalar(select(Watch).where(Watch.stop_token == token))
        if watch is None:
            raise NotFound("That link has expired", code="watch_missing")
        watch.status = "stopped"
        return {"stopped": True, "request": watch.text_redacted}


def open_match(match_id: str, session_id: str) -> dict[str, Any]:
    """The email link: build a fresh quote for this browser through the normal flow."""
    with transaction() as db:
        match = db.get(WatchMatch, match_id)
        if match is None:
            raise NotFound("That link has expired", code="watch_match_missing")
        watch = db.get(Watch, match.watch_id)
        merchant = db.get(Merchant, match.merchant_id)
        shop = {"slug": merchant.slug, "name": merchant.name}
        if not merchant.is_live:
            return {"status": "unavailable", "shop": shop}
        constraints, text, signature = dict(watch.constraints), watch.text_redacted, match.signature
    req = intent_service.ParseRequest(merchant=shop["slug"], text=text, controls=_controls(constraints, merchant), use_ai=False, persist=True)
    _, intent_id = intent_service.parse(req, session_id)
    proposal = recommendation.propose(intent_id or "", session_id, ai_rationale=False)
    options = proposal["options"]
    if not options:
        return {"status": "sold_out", "shop": shop}
    same = next((o for o in options if _signature(o) == signature), None)
    chosen = same or options[0]
    quote = quotes.create_from_option(session_id, proposal["proposal_id"], chosen["id"], chosen["default_slot_id"])
    with transaction() as db:
        row = db.get(WatchMatch, match_id, with_for_update=True)
        row.opened_at = row.opened_at or clock.now()
        row.quote_id = quote["id"]
    return {"status": "ready", "quote_id": quote["id"], "changed": same is None, "shop": shop}


# --------------------------------------------------------------------------- alerts inbox


def _sent(user: SessionUser, since):
    """Matches actually sent to this shopper (not the candidates the judge passed over), newest first."""
    return (select(WatchMatch).join(Watch, Watch.id == WatchMatch.watch_id)
            .where(Watch.user_id == user.user_id, WatchMatch.email_message_id.is_not(None), WatchMatch.created_at >= since))


def alerts(user: SessionUser) -> dict[str, Any]:
    """The shopper's watch matches as an inbox: each with its bundle, price and pickup, plus the unread count for the bell."""
    since = clock.now() - timedelta(days=ALERT_DAYS)
    with transaction() as db:
        rows = db.scalars(_sent(user, since).where(WatchMatch.dismissed_at.is_(None)).order_by(WatchMatch.created_at.desc()).limit(ALERT_LIMIT)).all()
        watches = {w.id: w for w in db.scalars(select(Watch).where(Watch.id.in_({r.watch_id for r in rows}))).all()} if rows else {}
        shops = {m.id: m for m in db.scalars(select(Merchant).where(Merchant.id.in_({r.merchant_id for r in rows}))).all()} if rows else {}
        skus = {(r.merchant_id, part.split(":")[0]) for r in rows for part in r.signature.split("|") if part}
        names = {(p.merchant_id, p.sku): p.name for p in db.scalars(select(Product).where(
            Product.merchant_id.in_({m for m, _ in skus}), Product.sku.in_({s for _, s in skus})))} if skus else {}
        items = []
        for r in rows:
            shop, watch = shops[r.merchant_id], watches.get(r.watch_id)
            lines = []
            for part in r.signature.split("|"):
                sku, _, qty = part.partition(":")
                if sku:
                    lines.append({"name": names.get((r.merchant_id, sku), sku), "qty": int(qty or 1)})
            items.append({
                "id": r.id, "shop": {"slug": shop.slug, "name": shop.name}, "label": r.label, "lines": lines,
                "summary": r.summary, "total_minor": r.total_minor, "currency": r.currency, "pickup_label": r.pickup_label,
                "created_at": clock.iso(r.created_at), "seen": r.seen_at is not None, "opened": r.opened_at is not None,
                "watch": {"id": watch.id, "request": watch.text_redacted, "status": watch.status} if watch else None,
            })
    return {"alerts": items, "unread": unread_count(user)}


def unread_count(user: SessionUser) -> int:
    since = clock.now() - timedelta(days=ALERT_DAYS)
    with transaction() as db:
        return db.scalar(select(func.count()).select_from(_sent(user, since).where(
            WatchMatch.dismissed_at.is_(None), WatchMatch.seen_at.is_(None), WatchMatch.opened_at.is_(None)).subquery())) or 0


def mark_seen(user: SessionUser) -> dict[str, Any]:
    now = clock.now()
    with transaction() as db:
        ids = db.scalars(_sent(user, now - timedelta(days=ALERT_DAYS)).where(WatchMatch.seen_at.is_(None)).with_only_columns(WatchMatch.id)).all()
        if ids:
            db.execute(update(WatchMatch).where(WatchMatch.id.in_(ids)).values(seen_at=now))
    return {"unread": 0}


def dismiss(user: SessionUser, match_id: str) -> dict[str, Any]:
    """'Not this': hide the alert. The watch keeps going, and the same bundle is never sent again."""
    with transaction() as db:
        match = db.get(WatchMatch, match_id, with_for_update=True)
        watch = db.get(Watch, match.watch_id) if match else None
        if match is None or watch is None or watch.user_id != user.user_id or match.email_message_id is None:
            raise NotFound("Alert not found", code="alert_missing")
        match.dismissed_at = match.dismissed_at or clock.now()
        match.seen_at = match.seen_at or clock.now()
    return {"dismissed": True}


# --------------------------------------------------------------------------- scanning


# Listings and inventory enqueue this kind (per shop, deduped) right after a relist or new stock.
@jobs.handler(SCAN_KIND, every=120)
def _scan_job(payload: dict[str, Any]) -> dict[str, Any]:
    return scan(merchant_id=payload.get("merchant_id"), watch_id=payload.get("watch_id"))


def scan(merchant_id: str | None = None, watch_id: str | None = None) -> dict[str, Any]:
    now = clock.now()
    with transaction() as db:
        db.execute(update(Watch).where(Watch.status == "active", Watch.expires_at < now).values(status="expired"))
        db.execute(delete(Watch).where(Watch.status.in_(("stopped", "expired")), Watch.updated_at < now - KEEP_ENDED))
        query = select(Watch).where(Watch.status == "active").order_by(Watch.created_at).limit(SCAN_LIMIT)
        if watch_id:
            query = query.where(Watch.id == watch_id)
        elif merchant_id:
            query = query.where(or_(Watch.merchant_id == merchant_id, Watch.merchant_id.is_(None)))
        watches = list(db.scalars(query).all())
        live = {m.id: m for m in list_merchants(db)}
        sent = {(m.watch_id, m.merchant_id, m.signature) for m in db.scalars(select(WatchMatch).where(WatchMatch.watch_id.in_([w.id for w in watches]))).all()} if watches else set()
        for obj in [*watches, *live.values()]:
            db.expunge(obj)
    notified = 0
    for watch in watches:
        if watch.last_notified_at and now - watch.last_notified_at < QUIET:
            continue
        shop_ids = [watch.merchant_id] if watch.merchant_id else ([merchant_id] if merchant_id else list(live))
        found: list[tuple[Merchant, dict[str, Any], str]] = []
        for mid in shop_ids:
            merchant = live.get(mid or "")
            if merchant is None:
                continue
            try:
                options = recommendation.code_options(mid, _intent(watch.constraints, merchant))
            except Exception:  # one shop's bad data must not stop the scan
                log.exception("watch scan failed for a shop", extra={"watch_id": watch.id, "merchant_id": mid})
                continue
            fresh = [(merchant, o, _signature(o)) for o in options if (watch.id, mid, _signature(o)) not in sent]
            found += sorted(fresh, key=lambda c: -c[1]["score"]["total"])[:PER_SHOP]
        ranked = sorted(found, key=lambda c: -c[1]["score"]["total"])[:CANDIDATES]
        candidates = [_Candidate(id=f"c{i}", merchant=m, opt=o, sig=sig) for i, (m, o, sig) in enumerate(ranked, start=1)]
        if candidates and _notify(watch, candidates):
            notified += 1
        with transaction() as db:
            db.execute(update(Watch).where(Watch.id == watch.id).values(last_scanned_at=now))
    return {"watches": len(watches), "notified": notified}


def _notify(watch: Watch, candidates: list[_Candidate]) -> bool:
    """Let the judge pick one candidate (or none), email it, and record every candidate so none is judged twice."""
    picked, summary, source, run_id = _judge(watch, candidates)
    with transaction() as db:
        user = db.get(User, watch.user_id)
        chosen: WatchMatch | None = None
        for cand in candidates:
            is_pick = picked is not None and cand.id == picked.id
            row = WatchMatch(id=new_id("wmt"), watch_id=watch.id, merchant_id=cand.merchant.id, signature=cand.sig, label=cand.opt["label"][:80],
                             summary=summary if is_pick else "", summary_source=source if is_pick else "skipped",
                             total_minor=cand.opt["totals"]["total_minor"], currency=cand.opt["totals"]["currency"],
                             pickup_label=cand.pickup_label[:80], agent_run_id=run_id, created_at=clock.now())
            try:
                with db.begin_nested():
                    db.add(row)
            except IntegrityError:  # another scan recorded it first
                continue
            if is_pick:
                chosen = row
        if picked is None or chosen is None or user is None:
            return False
        message = mail.queue(db, to=user.email, template="watch_match", link=mail.app_link(f"/watches/{chosen.id}"), context={
            "name": user.display_name.split(" ")[0] or "there", "shop": picked.merchant.name, "request": watch.text_redacted,
            "label": picked.opt["label"], "items": picked.items, "total": picked.total, "pickup": picked.pickup_label, "summary": summary,
            "stop_link": mail.app_link(f"/watches/stop/{watch.stop_token}"),
        })
        chosen.email_message_id = message.id
        db.execute(update(Watch).where(Watch.id == watch.id).values(last_notified_at=clock.now()))
    return True


def _judge(watch: Watch, candidates: list[_Candidate]) -> tuple[_Candidate | None, str, str, str | None]:
    """One-step agent: which code-approved bundle (if any) is what they asked for, and one line on why.
    Without a model, the best-scoring candidate is sent with a plain line."""
    result = run_agent(
        kind="watch_match", prompt_version=prompts.WATCH_PROMPT_VERSION, system=prompts.WATCH_SYSTEM,
        messages=[{"role": "user", "content": json.dumps({
            "shopper_request": watch.text_redacted,
            "candidates": [{"id": c.id, "shop": c.merchant.name, "label": c.opt["label"], "items": c.items, "pickup": c.pickup_label}
                           for c in candidates],
        }, ensure_ascii=False)}],
        tools=[Tool("notify", "Pick the bundle to email the shopper about, or none.", NotifyArgs, final=True)],
        user_id=watch.user_id, subject=("watch", watch.id), max_steps=2, timeout=25,
    )
    if result.ok and isinstance(result.final, NotifyArgs):
        picked = next((c for c in candidates if c.id == result.final.pick), None)
        if picked is None:
            return None, "", "skipped", result.run_id
        summary = clean_customer_prose(result.final.summary, allowed_amounts={picked.total.replace(" ", "")}, max_chars=200)
        return picked, summary or _rules_line(picked), "agent" if summary else "rules", result.run_id
    best = candidates[0]
    return best, _rules_line(best), "rules", result.run_id


def _rules_line(cand: _Candidate) -> str:
    return f"{cand.opt['label']} at {cand.merchant.name}: {', '.join(cand.items)}."


# --------------------------------------------------------------------------- helpers


def _intent(constraints: dict[str, Any], merchant: Merchant) -> Intent:
    return Intent.model_validate({**constraints, "pickup_date": clock.local_date(merchant.timezone).isoformat()})


def _controls(constraints: dict[str, Any], merchant: Merchant) -> intent_service.Controls:
    window = constraints.get("pickup_window")
    return intent_service.Controls(
        party_size=constraints.get("party_size"), budget_minor=constraints.get("budget_minor"),
        exclusions=[Exclusion.model_validate(e) for e in constraints.get("exclusions", [])],
        dietary=constraints.get("dietary", []), preferences=constraints.get("preferences", []), occasion=constraints.get("occasion"),
        pickup_date=clock.local_date(merchant.timezone).isoformat(), pickup_window=tuple(window) if window else None,
    )


def _signature(opt: dict[str, Any]) -> str:
    return "|".join(f"{ln['sku']}:{ln['qty']}" for ln in sorted(opt["lines"], key=lambda ln: ln["sku"]))[:300]


def _view(db, watch: Watch) -> dict[str, Any]:
    merchant = db.get(Merchant, watch.merchant_id) if watch.merchant_id else None
    c = watch.constraints
    facts = [f"{c['party_size']} {'person' if c.get('party_size') == 1 else 'people'}"] if c.get("party_size") else []
    if c.get("budget_minor"):
        facts.append(f"under {format_money(c['budget_minor'], c.get('currency', 'USD'))}")
    facts += [f"no {e['code'].replace('_', ' ')}" for e in c.get("exclusions", [])]
    if c.get("pickup_window"):
        facts.append(f"pickup {c['pickup_window'][0]}–{c['pickup_window'][1]}")
    matches = db.scalar(select(func.count()).select_from(WatchMatch).where(WatchMatch.watch_id == watch.id, WatchMatch.email_message_id.is_not(None)))
    return {
        "id": watch.id, "request": watch.text_redacted, "status": watch.status, "facts": facts,
        "shop": {"slug": merchant.slug, "name": merchant.name} if merchant else None,
        "expires_at": clock.iso(watch.expires_at), "last_notified_at": clock.iso(watch.last_notified_at),
        "matches_sent": matches or 0, "created_at": clock.iso(watch.created_at),
    }
