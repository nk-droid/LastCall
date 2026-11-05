"""IntentService (L1): natural language + explicit controls -> validated structured intent.

Precedence is fixed in code, not left to the model:
* Explicit controls always win and are the only way to relax a constraint.
* The deterministic parser always runs; the model may fill gaps or add exclusions but a
  model-only budget must match an amount in the text, and the final budget is the minimum
  of every accepted signal (never relaxed).
* Exclusions are a union. "strict" requires explicit allergy wording or the customer's
  choice; otherwise an exclusion stays "needs_confirmation" (treated as strict) and the UI asks.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from pydantic import BaseModel, Field

from app import clock
from app.ai import prompts
from app.ai.provider import AIOutcome, invoke_structured
from app.ai.sanitize import looks_like_injection
from app.db import transaction
from app.domain import ALLERGEN_LABELS, EXCLUSION_GROUPS, DietCode, Exclusion, Intent, Occasion, Preference
from app.ids import new_id
from app.models import CustomerIntent, Merchant
from app.money import format_money
from app.observability import redact
from app.services import analytics
from app.services.catalog import get_merchant
from app.services.pickup import reference_window


class Controls(BaseModel):
    """Values the customer set directly with UI controls. These always take precedence."""

    party_size: int | None = Field(default=None, ge=1, le=40)
    budget_minor: int | None = Field(default=None, ge=100, le=100_000)
    exclusions: list[Exclusion] = Field(default_factory=list)
    removed_exclusions: list[str] = Field(default_factory=list)
    dietary: list[DietCode] = Field(default_factory=list)
    pickup_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    pickup_window: tuple[str, str] | None = None
    occasion: Occasion | None = None
    preferences: list[Preference] = Field(default_factory=list)
    removed_preferences: list[str] = Field(default_factory=list)


class ParseRequest(BaseModel):
    text: str = Field(default="", max_length=600)
    controls: Controls = Field(default_factory=Controls)
    use_ai: bool = True
    persist: bool = True
    locale: str = Field(default="en-US", max_length=16)
    # Storefront slug of the shop the shopper is building a bundle at.
    merchant: str = Field(min_length=1, max_length=80)


# --------------------------------------------------------------------------- deterministic parser

_NUM_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20, "couple": 2, "dozen": 12,
}
_NUM = r"(\d{1,2}|" + "|".join(_NUM_WORDS) + r")"
_PARTY_A = re.compile(rf"\b{_NUM}\s+(?:people|persons|ppl|guests|kids|children|adults|friends|coworkers|colleagues|of us|folks)\b", re.I)
_PARTY_B = re.compile(rf"\b(?:for|feeds?|serves?|feeding|serving)\s+(?:about\s+|around\s+|a\s+)?{_NUM}\b(?!\s*(?::|am\b|pm\b|o'?clock|\$|dollars|bucks))", re.I)
_MONEY_NUM = r"(\d{1,4}(?:\.\d{1,2})?)"
_BUDGET_KEYWORD = re.compile(
    rf"\b(?:under|below|less than|max(?:imum)?|up to|no more than|at most|within|budget(?:\s+(?:of|is))?|spend(?:ing)?)\s*(?:a\s+)?(\$|usd\s*)?{_MONEY_NUM}\s*(dollars|bucks|usd)?",
    re.I,
)
_BARE_DOLLARS = re.compile(rf"\${_MONEY_NUM}")
_STRICT_WORDS = re.compile(r"\b(allerg\w*|anaphyla\w*|epi-?pen|celiac|coeliac|severe|life[- ]threatening)\b", re.I)
_EXCLUSION_PATTERNS: list[tuple[str, str]] = [
    (r"\bnut[- ]?free\b|\bno\s+(?:tree\s+)?nuts?\b|\bwithout\s+nuts?\b|\bnuts?\s+allerg\w*|\ballerg\w*\s+to\s+(?:tree\s+)?nuts?\b|\bavoid(?:ing)?\s+nuts?\b|\bno\s+nut\b", "nuts"),
    (r"\bpeanut[- ]?free\b|\bno\s+peanuts?\b|\bpeanuts?\s+allerg\w*|\ballerg\w*\s+to\s+peanuts?\b", "peanuts"),
    (r"\bdairy[- ]?free\b|\bno\s+(?:dairy|milk)\b|\blactose\b|\bwithout\s+(?:dairy|milk)\b|\b(?:milk|dairy)\s+allerg\w*|\ballerg\w*\s+to\s+(?:dairy|milk)\b", "dairy"),
    (r"\begg[- ]?free\b|\bno\s+eggs?\b|\bwithout\s+eggs?\b|\beggs?\s+allerg\w*|\ballerg\w*\s+to\s+eggs?\b", "eggs"),
    (r"\bgluten[- ]?free\b|\bno\s+(?:gluten|wheat)\b|\bc[o]?eliac\b|\bwheat\s+allerg\w*|\bwithout\s+(?:gluten|wheat)\b", "gluten"),
    (r"\bsoy[- ]?free\b|\bno\s+soy\b|\bsoy\s+allerg\w*", "soy"),
    (r"\bsesame[- ]?free\b|\bno\s+sesame\b|\bsesame\s+allerg\w*", "sesame"),
]
_OCCASIONS: list[tuple[str, str]] = [
    (r"\bbrunch\b", "brunch"),
    (r"\bbreakfast\b|\bmorning\b", "breakfast"),
    (r"\bsnacks?\b|\bsnacking\b", "snacks"),
    (r"\bdesserts?\b|\bsweet treats?\b", "dessert"),
    (r"\bpart(?:y|ies)\b|\bcelebrat\w*|\bbirthday\b", "party"),
    (r"\boffice\b|\bmeeting\b|\bteam\b|\bcoworkers?\b|\bcolleagues?\b", "office"),
    (r"\bpicnic\b", "picnic"),
    (r"\bdinner\b|\bsupper\b", "dinner"),
]
_PREFERENCES: list[tuple[str, str]] = [
    (r"sweet\s*(?:and|&|\+|/|or)\s*savou?ry|savou?ry\s*(?:and|&|\+|/|or)\s*sweet|mix of sweet", "sweet_and_savory"),
    (r"\bvariety\b|\bassort\w*|\ba mix\b", "variety"),
    (r"\bbreads?\b|\bloa(?:f|ves)\b|\bbaguettes?\b|\brolls?\b", "bread"),
    (r"\bpastr(?:y|ies)\b|\bcroissants?\b", "pastries"),
    (r"\bchocolate\b|\bcocoa\b", "chocolate"),
    (r"\bfruit\w*\b|\bberr(?:y|ies)\b", "fruit"),
    (r"\bkids?\b|\bchildren\b|\btoddlers?\b", "kid_friendly"),
]
_TIME = r"(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?"
_BETWEEN = re.compile(rf"\bbetween\s+{_TIME}\s*(?:and|-|–|to)\s*{_TIME}", re.I)
_RANGE = re.compile(rf"\b{_TIME}\s*(?:-|–|to)\s*{_TIME}(?!\s*(?:people|persons|ppl|guests|items|\$|dollars))", re.I)
_AFTER = re.compile(rf"\b(?:after|from|post)\s+{_TIME}(?!\s*(?:people|persons|ppl|guests|\$|dollars))", re.I)
_BEFORE = re.compile(rf"\b(?:before|by|until|no later than)\s+{_TIME}(?!\s*(?:people|persons|ppl|guests|\$|dollars))", re.I)
_AT = re.compile(rf"\b(?:at|around|about|~)\s+{_TIME}(?!\s*(?:people|persons|ppl|guests|\$|dollars))", re.I)


def _to_int(token: str) -> int:
    token = token.lower()
    return _NUM_WORDS[token] if token in _NUM_WORDS else int(token)


def _to_hhmm(hour: str, minute: str | None, meridiem: str | None, notes: list[str]) -> str | None:
    h = int(hour)
    m = int(minute or 0)
    if m > 59 or h > 23:
        return None
    mer = (meridiem or "").lower().replace(".", "")
    if mer == "pm" and h < 12:
        h += 12
    elif mer == "am" and h == 12:
        h = 0
    elif not mer and 1 <= h <= 9:
        h += 12
        notes.append("Assumed PM for pickup time")
    return f"{h:02d}:{m:02d}"


def _shift(hhmm: str, minutes: int) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    total = max(0, min(23 * 60 + 59, h * 60 + m + minutes))
    return f"{total // 60:02d}:{total % 60:02d}"


@dataclass
class RuleParse:
    party_size: int | None = None
    budget_candidates: list[int] = field(default_factory=list)
    exclusions: list[Exclusion] = field(default_factory=list)
    strict_codes: set[str] = field(default_factory=set)
    dietary: list[str] = field(default_factory=list)
    occasion: str | None = None
    preferences: list[str] = field(default_factory=list)
    pickup_window: tuple[str, str] | None = None
    pickup_date: str | None = None
    notes: list[str] = field(default_factory=list)
    has_strict_words: bool = False

    @property
    def budget_minor(self) -> int | None:
        return min(self.budget_candidates) if self.budget_candidates else None


def parse_rules(text: str, merchant: Merchant) -> RuleParse:
    out = RuleParse()
    if not text.strip():
        return out
    t = " " + text.strip() + " "
    cfg = merchant.pickup_config or {}
    open_t, close_t = reference_window(merchant)
    slot_minutes = int(cfg.get("slot_minutes", 30))

    for pattern in (_PARTY_A, _PARTY_B):
        match = pattern.search(t)
        if match:
            out.party_size = _to_int(match.group(1))
            break

    for match in _BUDGET_KEYWORD.finditer(t):
        currency_marker = match.group(1) or match.group(3)
        keyword = match.group(0).lower()
        if currency_marker or "budget" in keyword or "spend" in keyword:
            out.budget_candidates.append(round(float(match.group(2)) * 100))
    if not out.budget_candidates:
        for match in _BARE_DOLLARS.finditer(t):
            out.budget_candidates.append(round(float(match.group(1)) * 100))

    out.has_strict_words = bool(_STRICT_WORDS.search(t))
    found: dict[str, str] = {}
    for pattern, group in _EXCLUSION_PATTERNS:
        for match in re.finditer(pattern, t, re.I):
            window = t[max(0, match.start() - 45) : match.end() + 45]
            strict = bool(_STRICT_WORDS.search(window))
            for code in EXCLUSION_GROUPS[group]:
                if strict:
                    found[code] = "strict"
                    out.strict_codes.add(code)
                else:
                    found.setdefault(code, "needs_confirmation")
    out.exclusions = [Exclusion(code=code, severity=sev) for code, sev in found.items()]  # type: ignore[arg-type]

    if re.search(r"\bvegan\b", t, re.I):
        out.dietary.append("vegan")
    if re.search(r"\bvegetarian\b|\bveggie\b", t, re.I):
        out.dietary.append("vegetarian")

    for pattern, occasion in _OCCASIONS:
        if re.search(pattern, t, re.I):
            out.occasion = occasion
            break
    for pattern, pref in _PREFERENCES:
        if re.search(pattern, t, re.I):
            out.preferences.append(pref)
    if "sweet_and_savory" not in out.preferences:
        if re.search(r"\bsweet\b", t, re.I):
            out.preferences.append("sweet")
        if re.search(r"\bsavou?ry\b", t, re.I):
            out.preferences.append("savory")

    if re.search(r"\btomorrow\b", t, re.I):
        out.pickup_date = "tomorrow"
    elif re.search(r"\btoday\b|\btonight\b|\bthis (?:afternoon|evening)\b", t, re.I):
        out.pickup_date = "today"

    window: tuple[str, str] | None = None
    if (m := _BETWEEN.search(t)) or (m := _RANGE.search(t) if re.search(r"pick|collect|grab", t, re.I) else None):
        a = _to_hhmm(m.group(1), m.group(2), m.group(3) or m.group(6), out.notes)
        b = _to_hhmm(m.group(4), m.group(5), m.group(6), out.notes)
        if a and b:
            window = (a, b)
    elif m := _AFTER.search(t):
        a = _to_hhmm(m.group(1), m.group(2), m.group(3), out.notes)
        if a:
            window = (a, close_t)
    elif m := _BEFORE.search(t):
        b = _to_hhmm(m.group(1), m.group(2), m.group(3), out.notes)
        if b:
            window = (open_t, b)
    elif m := _AT.search(t):
        a = _to_hhmm(m.group(1), m.group(2), m.group(3), out.notes)
        if a:
            h, mi = (int(x) for x in a.split(":"))
            start_minutes = (h * 60 + mi) // slot_minutes * slot_minutes
            start = f"{start_minutes // 60:02d}:{start_minutes % 60:02d}"
            window = (start, _shift(start, slot_minutes))
    if window and window[0] < window[1]:
        out.pickup_window = window
    out.notes = sorted(set(out.notes))
    return out


def _amount_in_text(amount_minor: int, text: str) -> bool:
    whole = amount_minor / 100
    candidates = {f"{whole:g}", f"{whole:.2f}", str(int(whole)) if whole == int(whole) else f"{whole:.2f}"}
    return any(re.search(rf"(?<![\d.]){re.escape(c)}(?![\d])", text) for c in candidates)


def _number_in_text(value: int, text: str) -> bool:
    if re.search(rf"(?<!\d){value}(?!\d)", text):
        return True
    words = [w for w, n in _NUM_WORDS.items() if n == value]
    return any(re.search(rf"\b{w}\b", text, re.I) for w in words)


# --------------------------------------------------------------------------- merge


@dataclass
class ParseResult:
    intent: Intent
    fields: list[dict[str, Any]]
    clarifications: list[dict[str, Any]]
    warnings: list[dict[str, Any]]
    parser: str
    ai: dict[str, Any]
    summary: str = ""

    @property
    def state(self) -> str:
        if any(w["level"] == "error" for w in self.warnings):
            return "invalid"
        if self.clarifications:
            return "needs_clarification"
        return "ready"


def _resolve_date(value: str | None, merchant: Merchant) -> str:
    today = clock.local_date(merchant.timezone)
    if value == "tomorrow":
        return (today + timedelta(days=1)).isoformat()
    if value and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return value
    return today.isoformat()


def merge(req: ParseRequest, rules: RuleParse, ai: AIOutcome | None, merchant: Merchant) -> ParseResult:
    c = req.controls
    text = req.text or ""
    sources: dict[str, str] = {}
    notes: list[str] = list(rules.notes)
    ai_data: prompts.AIIntent | None = ai.data if ai and ai.ok else None
    rejected: list[str] = []

    # party size
    party = c.party_size
    if party is not None:
        sources["party_size"] = "control"
    elif rules.party_size is not None:
        party, sources["party_size"] = rules.party_size, "text"
        if ai_data and ai_data.party_size not in (None, rules.party_size):
            rejected.append("party_size")
    elif ai_data and ai_data.party_size is not None:
        if _number_in_text(ai_data.party_size, text):
            party, sources["party_size"] = ai_data.party_size, "ai"
        else:
            rejected.append("party_size")

    # budget: the minimum of every accepted signal; the model cannot introduce a larger one
    budget = c.budget_minor
    if budget is not None:
        sources["budget"] = "control"
    else:
        accepted = list(rules.budget_candidates)
        if ai_data and ai_data.budget_minor:
            if ai_data.budget_minor in rules.budget_candidates or (not rules.budget_candidates and _amount_in_text(ai_data.budget_minor, text)):
                accepted.append(ai_data.budget_minor)
            else:
                rejected.append("budget")
        if accepted:
            budget = min(accepted)
            sources["budget"] = "text" if budget in rules.budget_candidates else "ai"

    warnings: list[dict[str, Any]] = []
    if budget is not None and not 100 <= budget <= 100_000:
        warnings.append({"field": "budget", "level": "error", "message": "Budget must be between $1 and $1,000."})
        budget = None
    if party is not None and not 1 <= party <= 40:
        warnings.append({"field": "party_size", "level": "error", "message": "Bundles can be planned for 1 to 40 people."})
        party = None

    # exclusions: union, never silently removed or downgraded
    severity: dict[str, str] = {}
    origin: dict[str, str] = {}
    for ex in rules.exclusions:
        severity[ex.code] = ex.severity
        origin[ex.code] = "text"
    if ai_data:
        for ex in ai_data.exclusions:
            strict_ok = ex.severity == "strict" and rules.has_strict_words
            proposed = "strict" if strict_ok else "needs_confirmation"
            if ex.code not in severity:
                severity[ex.code] = proposed
                origin[ex.code] = "ai"
            elif proposed == "strict":
                severity[ex.code] = "strict"
    for code in c.removed_exclusions:
        if code in severity:
            severity.pop(code)
            origin.pop(code, None)
    for ex in c.exclusions:
        severity[ex.code] = ex.severity
        origin[ex.code] = "control"
    exclusions = [Exclusion(code=code, severity=sev) for code, sev in severity.items()]  # type: ignore[arg-type]

    dietary = list(dict.fromkeys([*c.dietary, *rules.dietary, *(ai_data.dietary if ai_data else [])]))

    # pickup window/date: controls > rules > model (validated against pickup hours)
    open_t, close_t = reference_window(merchant)
    window = c.pickup_window
    if window:
        sources["pickup"] = "control"
    elif rules.pickup_window:
        window, sources["pickup"] = rules.pickup_window, "text"
    elif ai_data and ai_data.pickup_window:
        candidate = tuple(ai_data.pickup_window)
        if all(re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", p) for p in candidate) and candidate[0] < candidate[1]:
            window, sources["pickup"] = candidate, "ai"  # type: ignore[assignment]
        else:
            rejected.append("pickup_window")
    if window:
        start, end = max(window[0], open_t), min(window[1], close_t)
        if start >= end:
            warnings.append({
                "field": "pickup",
                "level": "error",
                "message": f"Pickup {_fmt12(window[0])}–{_fmt12(window[1])} is outside today's pickup hours ({_fmt12(open_t)}–{_fmt12(close_t)}).",
            })
            window = None
        elif (start, end) != tuple(window):
            notes.append(f"Pickup window limited to pickup hours {_fmt12(open_t)}–{_fmt12(close_t)}")
            window = (start, end)
    pickup_date_raw = c.pickup_date or rules.pickup_date or (ai_data.pickup_date if ai_data else None)
    pickup_date = _resolve_date(pickup_date_raw, merchant)

    occasion = c.occasion or (ai_data.occasion if ai_data and ai_data.occasion else None) or rules.occasion
    if c.occasion:
        sources["occasion"] = "control"
    elif ai_data and ai_data.occasion:
        sources["occasion"] = "ai"
    elif rules.occasion:
        sources["occasion"] = "text"
    preferences = list(dict.fromkeys([*c.preferences, *rules.preferences, *(ai_data.preferences if ai_data else [])]))
    preferences = [p for p in preferences if p not in c.removed_preferences]

    intent = Intent(
        party_size=party,
        occasion=occasion,
        budget_minor=budget,
        currency=merchant.currency,
        pickup_date=pickup_date,
        pickup_window=window,
        exclusions=exclusions,
        dietary=dietary,  # type: ignore[arg-type]
        preferences=preferences,  # type: ignore[arg-type]
    )

    clarifications: list[dict[str, Any]] = []
    if intent.party_size is None:
        clarifications.append({
            "id": "party_size",
            "field": "party_size",
            "kind": "number",
            "question": "How many people are you shopping for?",
        })
    for ex in intent.exclusions:
        if ex.severity == "needs_confirmation":
            label = ALLERGEN_LABELS[ex.code]
            clarifications.append({
                "id": f"severity:{ex.code}",
                "field": f"exclusions.{ex.code}",
                "kind": "choice",
                "question": f"Is avoiding {label} a strict allergy requirement?",
                "help": "Strict means we only include items the shop has verified are free of it, with no cross-contact. Until you answer, we treat it as strict.",
                "options": [
                    {"value": "strict", "label": "Yes, strict allergy"},
                    {"value": "preference", "label": "No, just a preference"},
                ],
            })
    if looks_like_injection(text):
        warnings.append({
            "field": "text",
            "level": "info",
            "message": "Part of your message looked like an instruction to change how the shop works; it was ignored. Your budget and exclusions come only from what you asked for.",
        })
    if rejected:
        notes.append("Some AI suggestions didn't match your words and were ignored: " + ", ".join(sorted(set(rejected))))

    return ParseResult(
        intent=intent,
        fields=_fields(intent, sources, origin, merchant, notes),
        clarifications=clarifications,
        warnings=warnings,
        parser="ai+rules" if ai_data else "rules",
        ai={
            "used": bool(ai_data),
            "model": ai.model if ai else None,
            "latency_ms": ai.latency_ms if ai else 0,
            "fallback_reason": None if (ai is None or ai.ok) else ai.reason,
            "rejected_fields": sorted(set(rejected)),
        },
        summary=(ai_data.summary if ai_data else ""),
    )


def _fmt12(hhmm: str) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    return f"{(h % 12) or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


_PREF_LABELS = {
    "sweet": "Sweet", "savory": "Savory", "sweet_and_savory": "Sweet & savory", "variety": "Variety",
    "bread": "Bread", "pastries": "Pastries", "chocolate": "Chocolate", "fruit": "Fruit",
    "kid_friendly": "Kid-friendly", "handheld": "Handheld", "shareable": "Shareable",
}


def _fields(intent: Intent, sources: dict[str, str], origin: dict[str, str], merchant: Merchant, notes: list[str]) -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    if intent.party_size:
        occ = f" · {intent.occasion}" if intent.occasion else ""
        fields.append({"key": "party_size", "label": f"{intent.party_size} {'person' if intent.party_size == 1 else 'people'}{occ}", "source": sources.get("party_size", "text"), "status": "confirmed"})
    if intent.budget_minor:
        fields.append({"key": "budget", "label": f"Budget {format_money(intent.budget_minor, intent.currency)} max", "source": sources.get("budget", "text"), "status": "confirmed"})
    for ex in intent.exclusions:
        label = ALLERGEN_LABELS[ex.code]
        status = {"strict": "strict", "preference": "preference", "needs_confirmation": "needs_confirmation"}[ex.severity]
        fields.append({"key": f"exclusion:{ex.code}", "label": f"No {label}", "source": origin.get(ex.code, "text"), "status": status, "code": ex.code})
    for diet in intent.dietary:
        fields.append({"key": f"dietary:{diet}", "label": diet.capitalize(), "source": "text", "status": "strict"})
    day = "today" if intent.pickup_date == clock.local_date(merchant.timezone).isoformat() else intent.pickup_date
    if intent.pickup_window:
        a, b = intent.pickup_window
        fields.append({"key": "pickup", "label": f"Pickup {_fmt12(a)}–{_fmt12(b)} {day}", "source": sources.get("pickup", "text"), "status": "assumed" if "Assumed PM for pickup time" in notes else "confirmed"})
    else:
        fields.append({"key": "pickup", "label": f"Any pickup time {day}", "source": "default", "status": "default"})
    for pref in intent.preferences:
        fields.append({"key": f"preference:{pref}", "label": _PREF_LABELS.get(pref, pref), "source": "text", "status": "soft"})
    for note in notes:
        fields.append({"key": "note", "label": note, "source": "system", "status": "note"})
    return fields


def parse(req: ParseRequest, session_id: str) -> tuple[ParseResult, str | None]:
    with transaction() as db:
        merchant = get_merchant(db, req.merchant)
        db.expunge(merchant)
    redacted = redact(req.text)
    rules = parse_rules(redacted, merchant)
    ai_outcome: AIOutcome | None = None
    if req.use_ai and redacted.strip():
        ai_outcome = invoke_structured(
            task="L1_intent",
            prompt_version=prompts.INTENT_PROMPT_VERSION,
            system=prompts.intent_system(*reference_window(merchant)),
            payload={
                "message": redacted,
                "selected_controls": req.controls.model_dump(exclude_defaults=True),
                "today": clock.local_date(merchant.timezone).isoformat(),
                "locale": req.locale,
            },
            output_model=prompts.AIIntent,
        )
    result = merge(req, rules, ai_outcome, merchant)
    intent_id = None
    if req.persist:
        intent_id = new_id("int")
        with transaction() as db:
            db.add(
                CustomerIntent(
                    id=intent_id,
                    merchant_id=merchant.id,
                    session_id=session_id,
                    raw_text_redacted=redacted,
                    structured_constraints=result.intent.model_dump(mode="json"),
                    field_sources={f["key"]: f["source"] for f in result.fields},
                    clarifications=result.clarifications,
                    warnings=result.warnings,
                    parser=result.parser,
                    prompt_version=prompts.INTENT_PROMPT_VERSION if ai_outcome else "rules/1",
                    ai_invocation_id=ai_outcome.invocation_id if ai_outcome else None,
                )
            )
            analytics.track(
                db,
                "intent_submitted",
                merchant_id=merchant.id,
                session_id=session_id,
                entity_type="intent",
                entity_id=intent_id,
                properties={"parser": result.parser, "state": result.state, "ai_used": result.ai["used"]},
            )
    return result, intent_id


def view(result: ParseResult, intent_id: str | None) -> dict[str, Any]:
    return {
        "intent_id": intent_id,
        "state": result.state,
        "intent": result.intent.model_dump(mode="json"),
        "fields": result.fields,
        "clarifications": result.clarifications,
        "warnings": result.warnings,
        "parser": result.parser,
        "ai": result.ai,
        "summary": result.summary,
    }
