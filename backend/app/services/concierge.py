"""A1 shopping concierge: an agent that compares bundles across shops for a shopper's request.

Its tools wrap the build page's own pipeline: the deterministic request parser (so every allergen the
shopper typed is applied, whatever the agent passes) and the bundle engine (stock, allergen, budget and
pickup checks). The agent only chooses and explains. Holding stock and paying stay a shopper's click on
a card, which goes through the existing quote → review → PayPal flow.

Each shopper message is one agent run in the background; the page polls the conversation for
progress ("Checking Night Owl Doughnuts") and the reply. If the model is off or fails, the same tools
run with the rules parser only, so the chat still answers.
"""

from __future__ import annotations

import logging
import re
from datetime import date, timedelta
from types import SimpleNamespace
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app import clock
from app.ai import prompts
from app.ai.agent import AgentResult, Tool, ToolError, run_agent
from app.ai.sanitize import clean_customer_prose, looks_like_injection
from app.api.public import merchant_card
from app.db import transaction
from app.domain import ALLERGEN_LABELS, AllergenCode, DietCode, Exclusion, Occasion, Preference, mentions_free_from_claim
from app.errors import AppError, Conflict, NotFound
from app.ids import new_id
from app.models import Conversation, Merchant
from app.money import format_money
from app.observability import redact
from app.services import analytics, pickup, recommendation
from app.services import intent as intent_service
from app.services.catalog import get_merchant, list_merchants, policy

log = logging.getLogger(__name__)

MAX_SHOPS = 4
MAX_CARDS = 3
HISTORY = 12
STALE_AFTER = timedelta(seconds=120)
HHMM = r"^(?:[01]\d|2[0-3]):[0-5]\d$"


# --------------------------------------------------------------------------- tool contracts


class ListShopsArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")


class FindBundlesArgs(BaseModel):
    shop: str = Field(min_length=1, max_length=80, description="Shop slug from list_shops")
    party_size: int = Field(ge=1, le=40, description="How many people the food is for")
    budget_dollars: float | None = Field(default=None, ge=1, le=1000, description="Maximum spend in dollars, if the shopper gave one")
    allergens: list[AllergenCode] = Field(default_factory=list, description="Allergens to avoid")
    dietary: list[DietCode] = Field(default_factory=list)
    preferences: list[Preference] = Field(default_factory=list)
    occasion: Occasion | None = None
    pickup_day: Literal["today", "tomorrow"] = "today"
    pickup_after: str | None = Field(default=None, pattern=HHMM, description="Earliest pickup, 24-hour HH:MM")
    pickup_before: str | None = Field(default=None, pattern=HHMM, description="Latest pickup, 24-hour HH:MM")


class RespondArgs(BaseModel):
    message: str = Field(default="", max_length=600, description="At most two short sentences on why the options fit")
    option_ids: list[str] = Field(default_factory=list, max_length=MAX_CARDS, description="Best first; ids from find_bundles")
    questions: list[str] = Field(default_factory=list, max_length=2, description="Only when something essential is missing")


# --------------------------------------------------------------------------- conversation API


def send(session_id: str, user_id: str | None, text: str, conversation_id: str | None = None, shop: str | None = None) -> dict[str, Any]:
    """Store the shopper's message and mark the conversation as working. The caller runs ``run_turn`` next."""
    text = redact(re.sub(r"\s+", " ", text).strip())[:600]
    now = clock.now()
    with transaction() as db:
        if conversation_id:
            conv = db.get(Conversation, conversation_id, with_for_update=True)
            if conv is None or conv.session_id != session_id:
                raise NotFound("We couldn't find that conversation", code="conversation_missing")
            if conv.status == "working" and now - conv.updated_at < STALE_AFTER:
                raise Conflict("Still working on your last message", code="concierge_busy")
        else:
            scope_id = get_merchant(db, shop).id if shop else None
            conv = Conversation(id=new_id("cnv"), kind="concierge", session_id=session_id, user_id=user_id, scope_merchant_id=scope_id,
                                messages=[], progress=[])
            db.add(conv)
        conv.user_id = conv.user_id or user_id
        conv.messages = [*conv.messages, {"role": "user", "text": text, "at": clock.iso(now)}]
        conv.status = "working"
        conv.progress = []
        db.flush()
        return view(db, conv)


def get(session_id: str, conversation_id: str) -> dict[str, Any]:
    with transaction() as db:
        conv = db.get(Conversation, conversation_id, with_for_update=True)
        if conv is None or conv.session_id != session_id:
            raise NotFound("We couldn't find that conversation", code="conversation_missing")
        if conv.status == "working" and clock.now() - conv.updated_at > STALE_AFTER:
            # The run died with the process that was running it; let the shopper try again.
            conv.messages = [*conv.messages, _message("Sorry, that took too long. Please send your message again.", source="system")]
            conv.status = "idle"
        return view(db, conv)


def view(db, conv: Conversation) -> dict[str, Any]:
    scope = db.get(Merchant, conv.scope_merchant_id) if conv.scope_merchant_id else None
    return {
        "id": conv.id,
        "status": conv.status,
        "scope": {"slug": scope.slug, "name": scope.name} if scope else None,
        "messages": conv.messages,
        "progress": conv.progress,
    }


def run_turn(conversation_id: str) -> None:
    """Answer the latest shopper message (runs after the request that stored it)."""
    try:
        with transaction() as db:
            conv = db.get(Conversation, conversation_id)
            if conv is None or conv.status != "working":
                return
            scope = db.get(Merchant, conv.scope_merchant_id) if conv.scope_merchant_id else None
            session_id, user_id, messages = conv.session_id, conv.user_id, list(conv.messages)
            scope_ref = (scope.slug, scope.name) if scope else None
            zone = scope.timezone if scope else "America/Los_Angeles"
            today = clock.local_date(zone).strftime("%A, %B %-d")
            now_label = clock.display_time(clock.now(), zone)
        state: dict[str, Any] = {
            "conversation_id": conversation_id, "scope": scope_ref, "options": {}, "checked": [], "shops": {}, "merchant_ids": {}, "requests": {}, "board": {}, "understood": {}, "ask": {}, "listed": None,
            "shopper_text": " ".join(m["text"] for m in messages if m["role"] == "user")[-600:],
        }
        # Today's shops go in with the request, so the model can check them in its first turn instead of asking for the list.
        shops = None if scope_ref else _list_shops(SimpleNamespace(state=state), ListShopsArgs())["shops"]
        result = run_agent(
            kind="concierge", prompt_version=prompts.CONCIERGE_PROMPT_VERSION, system=prompts.concierge_system(today, scope_ref, now_label, shops),
            messages=[{"role": m["role"], "content": _history_text(m)} for m in messages[-HISTORY:] if m["role"] in ("user", "assistant")],
            tools=_tools(), session_id=session_id, user_id=user_id, subject=("conversation", conversation_id), state=state,
            turn_timeout=20,  # a hung turn gives up early enough for the one retry to fit the budget
        )
        reply = _agent_reply(result, state) or _rules_reply(state, session_id)
        reply["run_id"] = result.run_id
        _record_suggestions(state, session_id, reply)
    except Exception:  # the chat must always get an answer
        log.exception("concierge turn failed", extra={"conversation_id": conversation_id})
        reply, result = _message("Sorry, something went wrong on our side. Please try again.", source="system"), None
    with transaction() as db:
        conv = db.get(Conversation, conversation_id, with_for_update=True)
        if conv is None:
            return
        conv.messages = [*conv.messages, reply]
        conv.status = "idle"
        conv.last_run_id = result.run_id if result else conv.last_run_id


# --------------------------------------------------------------------------- tools


def _tools() -> list[Tool]:
    return [
        Tool("list_shops", "List LastCall shops with their pickup state today and how many surplus items they have.", ListShopsArgs, _list_shops),
        Tool("find_bundles", "Find bundles at one shop that fit the request. Code checks stock, allergens, budget and pickup time; "
             "every option returned already passed those checks.", FindBundlesArgs, _find_bundles),
        Tool("respond", "Reply to the shopper with up to 3 options (best first) and/or a question. Ends your turn.", RespondArgs, final=True),
    ]


def _list_shops(ctx, args: ListShopsArgs) -> dict[str, Any]:
    _progress(ctx.state, "Looking at today's shops")
    now = clock.now()
    with transaction() as db:
        cards = [merchant_card(db, m, now) for m in _listed(db, ctx.state["scope"])]
    shops = []
    ctx.state["listed"] = len(cards)
    for c in cards:
        ctx.state["shops"][c["slug"]] = c["name"]
        shops.append({
            "shop": c["slug"], "name": c["name"], "category": c["category"], "neighborhood": c["neighborhood"],
            "pickup": c["pickup"]["state"], "pickup_today": (c["pickup"].get("today_window") or {}).get("label"),
            "surplus_items": c["surplus"]["items_available"],
        })
    return {"shops": shops}


def _find_bundles(ctx, args: FindBundlesArgs) -> dict[str, Any]:
    scope = ctx.state["scope"]
    if scope and args.shop != scope[0]:
        raise ToolError(f"This chat is only for {scope[1]}; use shop {scope[0]!r}.")
    checked: list[str] = ctx.state["checked"]
    if args.shop not in checked and len(checked) >= MAX_SHOPS:
        raise ToolError(f"You have already checked {MAX_SHOPS} shops; choose from those options.")
    return _search(ctx.state, ctx.session_id, args.shop, args)


def _search(state: dict[str, Any], session_id: str, slug: str, args: FindBundlesArgs | None) -> dict[str, Any]:
    """Parse the request for one shop and run the bundle engine. ``args=None`` uses the rules parser alone."""
    with transaction() as db:
        try:
            merchant = get_merchant(db, slug)
        except NotFound:
            raise ToolError(f"There is no open shop {slug!r}. Use a slug from list_shops.") from None
        if not state["scope"] and not policy(merchant, "concierge_listed", True):
            raise ToolError(f"There is no open shop {slug!r}. Use a slug from list_shops.")
        db.expunge(merchant)
    if slug not in state["checked"]:
        state["checked"].append(slug)
    state["shops"][slug] = merchant.name
    _progress(state, f"Checking {merchant.name}")
    req = intent_service.ParseRequest(merchant=slug, text=state["shopper_text"], controls=_controls(args, merchant) if args else intent_service.Controls(),
                                      use_ai=False, persist=True)
    parsed, intent_id = intent_service.parse(req, session_id)
    if parsed.intent.party_size is None:
        raise ToolError("How many people is this for? Ask the shopper.")
    try:
        proposal = recommendation.propose(intent_id or "", session_id, ai_rationale=False)
    except AppError as exc:
        raise ToolError(exc.message) from None
    intent = proposal["intent"]
    request = _request(intent, merchant)
    options = []
    for opt in proposal["options"]:
        card = _card(proposal, opt, merchant)
        card["checks"] = _checks(intent, request, opt, card, merchant)
        state["options"][card["option_id"]] = card
        options.append({
            "option_id": card["option_id"], "label": opt["label"], "items": ", ".join(f"{ln['qty']} × {ln['name']}" for ln in opt["lines"]),
            "total": format_money(card["total_minor"], card["currency"]), "servings": round(float(opt["servings"]), 1),
            "pickup": card["pickup_label"], "why": opt["why"],
        })
    applied = {
        "party_size": intent.get("party_size"),
        "budget": format_money(intent["budget_minor"], merchant.currency) if intent.get("budget_minor") else None,
        "avoiding": sorted({e["code"] for e in intent.get("exclusions", [])}),
        "pickup": intent.get("pickup_window"),
    }
    result: dict[str, Any] = {"shop": merchant.name, "applied": applied, "options": options}
    if not options and proposal.get("no_match"):
        result["no_match"] = {"headline": proposal["no_match"].get("headline"), "suggestions": proposal["no_match"].get("suggestions", [])[:3]}
    # What the shop sees on its Assistant page: the request as structured facts (never the shopper's words).
    state["merchant_ids"][slug] = merchant.id
    state["requests"][slug] = request
    # For the reply's "how we picked this": what was applied, what this shop offered, and why it was passed on.
    state["understood"][slug] = _understood(parsed.fields, request)
    state.setdefault("ask", {})[slug] = _ask(intent, request, merchant)
    risky = [e["name"] for e in proposal.get("excluded", []) if any(_RISKY.search(r) for r in e.get("reasons", []))]
    state["board"][slug] = {
        "slug": slug, "name": merchant.name, "options": len(options), "currency": merchant.currency,
        "from_minor": min((state["options"][o["option_id"]]["total_minor"] for o in options), default=None),
        "reason": result["no_match"]["headline"] if "no_match" in result else (None if options else "No bundle fits right now."),
        "left_out": risky[:8], "left_out_count": len(risky),
    }
    props: dict[str, Any] = {"conversation_id": state["conversation_id"], "options": len(options), "request": request}
    if not options:
        props["gap"] = (proposal.get("no_match") or {}).get("code", "other")
    try:
        with transaction() as db:
            analytics.track(db, "concierge_checked", merchant_id=merchant.id, session_id=session_id, entity_type="proposal",
                            entity_id=proposal["proposal_id"], properties=props)
    except Exception:  # analytics must never break the chat
        log.exception("failed to record concierge check")
    return result


def _request(intent: dict[str, Any], merchant: Merchant) -> dict[str, Any]:
    window = intent.get("pickup_window")
    day = date.fromisoformat(intent["pickup_date"]) if intent.get("pickup_date") else clock.local_date(merchant.timezone)
    if window and tuple(window) == pickup.window_for(merchant, day):
        window = None  # the shop's whole pickup window: the shopper didn't ask for a time
    return {
        "party_size": intent.get("party_size"), "budget_minor": intent.get("budget_minor"), "currency": intent.get("currency", "USD"),
        "exclusions": sorted({e["code"] for e in intent.get("exclusions", [])}), "dietary": list(intent.get("dietary", [])),
        "preferences": list(intent.get("preferences", []))[:3], "occasion": intent.get("occasion"), "pickup_window": window,
    }


_RISKY = re.compile(r"^(Contains|May contain|Allergen information not merchant-verified|Not merchant-verified)")
EDITABLE = {"party_size", "budget", "pickup"}


def _understood(fields: list[dict[str, Any]], request: dict[str, Any]) -> list[dict[str, Any]]:
    """The parsed request as chips: allergens and diets are strict (always applied); size, budget and time can be changed."""
    out = []
    for f in fields:
        key = f["key"]
        if key == "note":
            continue
        label = f["label"]
        if key == "pickup" and not request.get("pickup_window"):
            label = "Any pickup time"
        elif key == "budget" and request.get("budget_minor"):
            label = f"Under {format_money(request['budget_minor'], request.get('currency', 'USD'))}"
        out.append({"key": key, "label": label, "strict": key.startswith(("exclusion:", "dietary:")), "editable": key in EDITABLE})
    return out


# The request read back as one sentence ("Savory food for 6 people, under $25, picked up after 5 PM today, with no
# peanuts or tree nuts."), and how each bundle meets every part of it. Parts with a key are the ones the page lets the
# shopper tap: size, budget, time and taste can be changed; allergies and diets are strict and only shown.
_NOUNS = {"brunch": "brunch", "breakfast": "breakfast", "snacks": "snacks", "dessert": "dessert", "party": "party food",
          "office": "office treats", "picnic": "picnic food", "dinner": "dinner"}
_PREF_WORDS = {"sweet": "sweet", "savory": "savory", "sweet_and_savory": "sweet & savory", "variety": "mixed", "chocolate": "chocolate",
               "fruit": "fruity", "kid_friendly": "kid-friendly", "handheld": "handheld", "shareable": "shareable"}
_PREF_NOUNS = {"bread": "bread", "pastries": "pastries"}
_PREF_TAGS = {"chocolate", "fruit", "kid_friendly", "handheld", "shareable"}


def _join(items: list[str], word: str = "and") -> str:
    return f"{', '.join(items[:-1])} {word} {items[-1]}" if len(items) > 1 else (items[0] if items else "")


def _short_time(hhmm: str) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    return f"{(h % 12) or 12}{f':{m:02d}' if m else ''} {'AM' if h < 12 else 'PM'}"


def _short_money(minor: int, currency: str) -> str:
    text = format_money(minor, currency)
    return text[:-3] if text.endswith(".00") else text


def _people(n: int) -> str:
    return f"{n} {'person' if n == 1 else 'people'}"


def _when(intent: dict[str, Any], merchant: Merchant) -> str:
    """"after 5 PM today", "by 7 PM tomorrow", "between 5 and 7 PM today" or "any time today".

    Read from the window as asked, not the shop-facing request: "after 5 PM" at a shop that opens at 5 is the shop's
    whole window, but it's still what the shopper said. Only a whole day at a 24-hour shop reads as "any time"."""
    today = clock.local_date(merchant.timezone)
    day = date.fromisoformat(intent["pickup_date"]) if intent.get("pickup_date") else today
    word = "today" if day == today else "tomorrow" if day == today + timedelta(days=1) else day.strftime("%a %b %-d")
    window = intent.get("pickup_window")
    shop = pickup.window_for(merchant, day)
    if not window or (tuple(window) == shop and shop == ("00:00", "23:59")):
        return f"any time {word}"
    start, end = window
    if shop and end >= shop[1]:
        return f"after {_short_time(start)} {word}"
    if shop and start <= shop[0]:
        return f"by {_short_time(end)} {word}"
    return f"between {_short_time(start)} and {_short_time(end)} {word}"


def _ask(intent: dict[str, Any], request: dict[str, Any], merchant: Merchant) -> list[dict[str, str]]:
    words = [{"key": f"dietary:{d}", "text": d} for d in request["dietary"]]
    noun = {"text": _NOUNS.get(request.get("occasion") or "", "food")}
    for pref in intent.get("preferences", []):
        if pref in _PREF_NOUNS and "key" not in noun:
            noun = {"key": f"preference:{pref}", "text": _PREF_NOUNS[pref]}
        elif pref in _PREF_WORDS:
            words.append({"key": f"preference:{pref}", "text": _PREF_WORDS[pref]})
    parts: list[dict[str, str]] = []
    for word in [*words, noun]:
        if parts:
            parts.append({"text": " "})
        parts.append(dict(word))
    parts[0]["text"] = parts[0]["text"][:1].upper() + parts[0]["text"][1:]
    if request.get("party_size"):
        parts += [{"text": " for "}, {"key": "party_size", "text": _people(request["party_size"])}]
    if request.get("budget_minor"):
        parts += [{"text": ", under "}, {"key": "budget", "text": _short_money(request["budget_minor"], request["currency"])}]
    parts += [{"text": ", picked up "}, {"key": "pickup", "text": _when(intent, merchant)}]
    if request["exclusions"]:
        parts += [{"text": ", with "}, {"key": "exclusions", "text": "no " + _join([ALLERGEN_LABELS[c] for c in request["exclusions"]], "or")}]
    parts.append({"text": "."})
    merged: list[dict[str, str]] = []
    for part in parts:  # neighbouring plain text reads as one run
        if merged and "key" not in part and "key" not in merged[-1]:
            merged[-1] = {"text": merged[-1]["text"] + part["text"]}
        else:
            merged.append(part)
    return merged


def _names(lines: list[dict[str, Any]]) -> str:
    names = [ln["name"] for ln in lines]
    return _join(names) if len(names) <= 2 else f"{names[0]}, {names[1]} and {len(names) - 2} more"


def _taste(pref: str, lines: list[dict[str, Any]], units: int) -> tuple[bool, str]:
    """Whether a bundle has what a taste preference asked for, from each item's own flavor, category and tags."""
    if pref == "variety":
        return len(lines) > 1, f"{len(lines)} different items"
    sweet = sum(ln["qty"] for ln in lines if ln.get("flavor") == "sweet")
    if pref == "sweet_and_savory":
        if sweet and units - sweet:
            return True, f"{sweet} sweet and {units - sweet} savory"
        return False, f"All {'sweet' if sweet else 'savory'}, the closest fit"
    def has(ln: dict[str, Any]) -> bool:
        if pref == "sweet":
            return ln.get("flavor") == "sweet"
        if pref == "savory":
            return ln.get("flavor") != "sweet"
        if pref == "bread":
            return ln.get("category") == "bread"
        if pref == "pastries":
            return ln.get("category") == "pastry"
        return pref in _PREF_TAGS and pref in (ln.get("tags") or [])
    hits = [ln for ln in lines if has(ln)]
    count = sum(ln["qty"] for ln in hits)
    if not hits:
        return False, f"Nothing {_PREF_WORDS.get(pref) or _PREF_NOUNS.get(pref, pref)} left, so this is the closest fit"
    return True, _names(hits) if count == units else f"{count} of {units}: {_names(hits)}"


def _checks(intent: dict[str, Any], request: dict[str, Any], opt: dict[str, Any], card: dict[str, Any], merchant: Merchant) -> list[dict[str, Any]]:
    """Each part of the request beside what this bundle does about it. Every answer comes from the engine's own numbers."""
    cur = card["currency"]
    rows: list[dict[str, Any]] = []
    party = request.get("party_size")
    if party:
        each = round(float(opt["servings"]) / party, 1)
        share = "one" if each == 1 else f"about {each:g}"
        units = opt["units"]
        rows.append({"key": "party_size", "asked": _people(party), "answer": f"{units} item{'' if units == 1 else 's'}, {share} per person", "ok": True})
    if request.get("budget_minor"):
        left = request["budget_minor"] - card["total_minor"]
        total = format_money(card["total_minor"], cur)
        rows.append({"key": "budget", "asked": f"Under {_short_money(request['budget_minor'], cur)}", "ok": left >= 0,
                     "answer": f"{total}, with {format_money(left, cur)} to spare" if left > 0 else f"{total}, right at your budget"})
    when = _when(intent, merchant)
    rows.append({"key": "pickup", "asked": when[:1].upper() + when[1:], "ok": bool(card["pickup_label"]),
                 "answer": f"Pickup {card['pickup_label']}" if card["pickup_label"] else "No pickup time left"})
    allergens = [ALLERGEN_LABELS[c] for c in request["exclusions"]]
    diets = list(request["dietary"])
    if allergens or diets:
        strict = any(e.get("severity") in ("strict", "needs_confirmation") for e in intent.get("exclusions", []))
        asked = [*(d.capitalize() for d in diets), *([("no " if diets else "No ") + _join(allergens, "or")] if allergens else [])]
        claims = [*([f"free of {_join(allergens)}"] if allergens else []), *([f"as {_join(diets)}"] if diets else [])]
        rows.append({"key": "exclusions", "asked": ", ".join(asked), "strict": True,
                     "ok": any(f["key"] == "exclusions" for f in opt["fits"]),
                     "answer": f"{merchant.name} lists every item {' and '.join(claims)}{', with no cross-contact' if strict and allergens else ''}"})
    for pref in intent.get("preferences", []):
        ok, answer = _taste(pref, opt["lines"], opt["units"])
        rows.append({"key": f"preference:{pref}", "asked": intent_service.PREF_LABELS.get(pref, pref), "answer": answer, "ok": ok})
    return rows


def _details(state: dict[str, Any], cards: list[dict[str, Any]]) -> dict[str, Any] | None:
    board: dict[str, dict[str, Any]] = state.get("board") or {}
    if not board:
        return None
    top = cards[0]["shop"]["slug"] if cards else None
    shown = {c["shop"]["slug"] for c in cards}
    basis = top if top in state["understood"] else next(reversed(state["understood"]), None)
    first = {}
    for c in cards:
        first.setdefault(c["shop"]["slug"], c)
    shops = [{**entry, "top": entry["slug"] == top, "shown": entry["slug"] in shown,
              "shown_total_minor": first[entry["slug"]]["total_minor"] if entry["slug"] in first else None,
              "shown_units": first[entry["slug"]]["units"] if entry["slug"] in first else None} for entry in board.values()]
    return {"understood": state["understood"].get(basis, []), "ask": state.get("ask", {}).get(basis, []), "shops": shops, "listed": state.get("listed")}


def _listed(db, scope: tuple[str, str] | None) -> list[Merchant]:
    """Shops the assistant may suggest: every live shop that hasn't opted out (a chat on one storefront is that shop's own)."""
    merchants = list_merchants(db)
    return merchants if scope else [m for m in merchants if policy(m, "concierge_listed", True)]


def _record_suggestions(state: dict[str, Any], session_id: str, reply: dict[str, Any]) -> None:
    """One event per bundle shown to the shopper, on the shop's own timeline."""
    try:
        with transaction() as db:
            for card in reply.get("cards", []):
                slug = card["shop"]["slug"]
                merchant_id = state["merchant_ids"].get(slug)
                if not merchant_id:
                    continue
                analytics.track(db, "concierge_suggested", merchant_id=merchant_id, session_id=session_id, entity_type="proposal",
                                entity_id=card["proposal_id"], properties={
                                    "conversation_id": state["conversation_id"], "option_key": card["option_key"], "label": card["label"],
                                    "units": card["units"], "total_minor": card["total_minor"], "currency": card["currency"],
                                    "request": state["requests"].get(slug, {}), "source": reply.get("source"),
                                })
    except Exception:  # analytics must never break the chat
        log.exception("failed to record concierge suggestions")


def _controls(args: FindBundlesArgs, merchant: Merchant) -> intent_service.Controls:
    day = clock.local_date(merchant.timezone) + timedelta(days=1 if args.pickup_day == "tomorrow" else 0)
    window = None
    if args.pickup_after or args.pickup_before:
        ref = pickup.window_for(merchant, day) or pickup.reference_window(merchant)
        start, end = args.pickup_after or ref[0], args.pickup_before or ref[1]
        window = (start, end) if start < end else None
    return intent_service.Controls(
        party_size=args.party_size,
        budget_minor=round(args.budget_dollars * 100) if args.budget_dollars else None,
        exclusions=[Exclusion(code=code, severity="strict") for code in dict.fromkeys(args.allergens)],
        dietary=list(dict.fromkeys(args.dietary)),
        preferences=list(dict.fromkeys(args.preferences)),
        occasion=args.occasion,
        pickup_date=day.isoformat(),
        pickup_window=window,
    )


def _card(proposal: dict[str, Any], opt: dict[str, Any], merchant: Merchant) -> dict[str, Any]:
    totals = opt["totals"]
    slots = opt.get("pickup_slots") or []
    return {
        "option_id": f"{proposal['proposal_id']}:{opt['id']}",
        "proposal_id": proposal["proposal_id"],
        "option_key": opt["id"],
        "shop": {"slug": merchant.slug, "name": merchant.name},
        "label": opt["label"],
        "kind": opt["kind"],
        "lines": [{"name": ln["name"], "qty": ln["qty"], "image": ln.get("image")} for ln in opt["lines"]],
        "units": opt["units"],
        "total_minor": totals["total_minor"],
        "reference_minor": totals.get("reference_minor", totals["total_minor"]),
        "discount_minor": totals.get("discount_minor", 0),
        "currency": totals["currency"],
        "fits": opt["fits"],
        "pickup_label": slots[0]["label"] if slots else None,
        "default_slot_id": opt["default_slot_id"],
        "score": opt["score"]["total"],
    }


def _progress(state: dict[str, Any], label: str) -> None:
    try:
        with transaction() as db:
            conv = db.get(Conversation, state["conversation_id"], with_for_update=True)
            if conv is not None and label not in conv.progress:
                conv.progress = [*conv.progress, label]
    except Exception:  # progress is cosmetic
        log.exception("failed to record concierge progress")


# --------------------------------------------------------------------------- replies


def _agent_reply(result: AgentResult, state: dict[str, Any]) -> dict[str, Any] | None:
    options: dict[str, dict[str, Any]] = state["options"]
    if result.ok and isinstance(result.final, RespondArgs):
        final = result.final
        questions = [q.strip() for q in final.questions if q.strip() and not looks_like_injection(q) and not mentions_free_from_claim(q)][:2]
        cards = [options[i] for i in dict.fromkeys(final.option_ids) if i in options][:MAX_CARDS]
        if not cards and options and not questions:
            cards = _top(options)
        return _reply(final.message, cards, questions, state, source="agent")
    if result.ok and result.text:
        return _reply(result.text, _top(options), [], state, source="agent")
    if options:  # the run stopped early but had already found options
        return _reply("", _top(options), [], state, source="agent")
    return None


def _rules_reply(state: dict[str, Any], session_id: str) -> dict[str, Any]:
    """No model: run the same search with the rules parser on every open shop (or the chat's shop)."""
    if state["scope"]:
        slugs = [state["scope"][0]]
    else:
        with transaction() as db:
            now = clock.now()
            cards = [merchant_card(db, m, now) for m in _listed(db, None)]
        slugs = [c["slug"] for c in cards if c["pickup"]["state"] == "open" and c["surplus"]["items_available"]][:MAX_SHOPS]
    for slug in slugs:
        try:
            _search(state, session_id, slug, None)
        except ToolError as exc:
            if "How many people" in str(exc):
                return _message("", source="rules", questions=["How many people are you shopping for?"])
    return _reply("", _top(state["options"]), [], state, source="rules")


def _reply(text: str, cards: list[dict[str, Any]], questions: list[str], state: dict[str, Any], *, source: str) -> dict[str, Any]:
    allowed = {format_money(c["total_minor"], c["currency"]).replace(" ", "") for c in cards}
    plain = re.sub(r"[*_`#>]+", "", text or "").replace("\n", " ")
    clean = clean_customer_prose(plain, allowed_amounts=allowed, max_chars=400)
    if not clean:
        if cards:
            shops = list(dict.fromkeys(c["shop"]["name"] for c in cards))
            names = shops[0] if len(shops) == 1 else ", ".join(shops[:-1]) + f" and {shops[-1]}"
            clean = f"Here {'is an option' if len(cards) == 1 else f'are {len(cards)} options'} from {names} that fit your request."
        elif not questions:
            clean = "I couldn't find a bundle that fits right now. Try a later pickup, a larger budget or fewer people."
    message = _message(clean, source=source, cards=cards, questions=questions)
    details = _details(state, cards)
    if details:
        message["details"] = details
    return message


def _message(text: str, *, source: str, cards: list[dict[str, Any]] | None = None, questions: list[str] | None = None) -> dict[str, Any]:
    return {"role": "assistant", "text": text, "cards": cards or [], "questions": questions or [], "source": source, "at": clock.iso(clock.now())}


def _top(options: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Best option per shop first, then the next best overall."""
    ranked = sorted(options.values(), key=lambda c: -c["score"])
    picks: list[dict[str, Any]] = []
    for card in ranked:
        if card["shop"]["slug"] not in {p["shop"]["slug"] for p in picks}:
            picks.append(card)
    picks += [c for c in ranked if c not in picks]
    return picks[:MAX_CARDS]


def _history_text(message: dict[str, Any]) -> str:
    if message["role"] != "assistant":
        return message["text"]
    parts = [message.get("text") or ""]
    if message.get("cards"):
        parts.append("Options shown: " + "; ".join(f"{c['shop']['name']} – {c['label']}" for c in message["cards"]))
    if message.get("questions"):
        parts.append("Asked: " + " ".join(message["questions"]))
    return " ".join(p for p in parts if p)
