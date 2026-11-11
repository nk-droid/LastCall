"""Shared domain vocabulary: the structured intent contract and dietary eligibility rules.

Dietary rules fail closed. A strict exclusion (or one still awaiting confirmation) only
admits an item whose allergen data the merchant has verified, that does not contain the
allergen, and that lists no cross-contact for it. Missing or uncertain data excludes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

AllergenCode = Literal["tree_nuts", "peanuts", "milk", "eggs", "wheat", "soy", "sesame"]
Severity = Literal["strict", "preference", "needs_confirmation"]
DietCode = Literal["vegetarian", "vegan"]
Occasion = Literal["snacks", "breakfast", "brunch", "dessert", "party", "office", "picnic", "dinner", "other"]
Preference = Literal[
    "sweet",
    "savory",
    "sweet_and_savory",
    "variety",
    "bread",
    "pastries",
    "chocolate",
    "fruit",
    "kid_friendly",
    "handheld",
    "shareable",
]

ALLERGENS: tuple[str, ...] = ("tree_nuts", "peanuts", "milk", "eggs", "wheat", "soy", "sesame")
ALLERGEN_LABELS: dict[str, str] = {
    "tree_nuts": "tree nuts",
    "peanuts": "peanuts",
    "milk": "milk",
    "eggs": "eggs",
    "wheat": "wheat (gluten)",
    "soy": "soy",
    "sesame": "sesame",
}
# Customer-facing groups expand to every allergen they could mean ("no nuts" covers both).
EXCLUSION_GROUPS: dict[str, tuple[str, ...]] = {
    "nuts": ("tree_nuts", "peanuts"),
    "tree_nuts": ("tree_nuts",),
    "peanuts": ("peanuts",),
    "dairy": ("milk",),
    "milk": ("milk",),
    "eggs": ("eggs",),
    "gluten": ("wheat",),
    "wheat": ("wheat",),
    "soy": ("soy",),
    "sesame": ("sesame",),
}

# Words that indicate an ingredient from an allergen group. Used to stop AI-drafted copy
# from mentioning allergens the merchant did not list, and to flag risky product text.
ALLERGEN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "tree_nuts": ("almond", "walnut", "pecan", "hazelnut", "pistachio", "cashew", "macadamia", "praline", "marzipan", "frangipane", "nut"),
    "peanuts": ("peanut",),
    "milk": ("milk", "butter", "cream", "cheese", "dairy", "yogurt", "feta", "cheddar", "parmesan", "ricotta"),
    "eggs": ("egg",),
    "wheat": ("wheat", "flour", "gluten", "rye", "barley", "spelt", "semolina"),
    "soy": ("soy", "soya", "tofu", "lecithin"),
    "sesame": ("sesame", "tahini"),
}

_FREE_FROM = re.compile(
    r"\b(?:[a-z]+[- ]free|free (?:of|from)|allerg(?:y|en)[- ]?(?:friendly|safe)|safe for|hypoallergenic|no (?:nuts|dairy|gluten|eggs|soy|sesame|peanuts))\b",
    re.IGNORECASE,
)


def mentions_free_from_claim(text: str) -> bool:
    return bool(_FREE_FROM.search(text))


def allergen_mentions(text: str) -> set[str]:
    lowered = text.lower()
    found: set[str] = set()
    for code, words in ALLERGEN_KEYWORDS.items():
        for word in words:
            if re.search(rf"\b{re.escape(word)}", lowered):
                found.add(code)
                break
    return found


class Exclusion(BaseModel):
    code: AllergenCode
    severity: Severity

    @property
    def is_strict(self) -> bool:
        # Unconfirmed exclusions are treated as strict until the customer says otherwise.
        return self.severity in ("strict", "needs_confirmation")


class Intent(BaseModel):
    """Structured shopping intent (the L1 contract). Money in minor units, times merchant-local."""

    party_size: int | None = Field(default=None, ge=1, le=40)
    occasion: Occasion | None = None
    budget_minor: int | None = Field(default=None, ge=100, le=100_000)
    currency: str = "USD"
    pickup_date: str | None = None
    pickup_window: tuple[str, str] | None = None
    exclusions: list[Exclusion] = Field(default_factory=list)
    dietary: list[DietCode] = Field(default_factory=list)
    preferences: list[Preference] = Field(default_factory=list)

    @field_validator("pickup_window")
    @classmethod
    def _window_order(cls, value: tuple[str, str] | None) -> tuple[str, str] | None:
        if value is None:
            return None
        start, end = value
        for part in (start, end):
            if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", part):
                raise ValueError("pickup times must be HH:MM")
        if start >= end:
            raise ValueError("pickup window must end after it starts")
        return value

    @field_validator("exclusions")
    @classmethod
    def _dedupe_exclusions(cls, value: list[Exclusion]) -> list[Exclusion]:
        rank = {"strict": 2, "needs_confirmation": 1, "preference": 0}
        best: dict[str, Exclusion] = {}
        for ex in value:
            current = best.get(ex.code)
            if current is None or rank[ex.severity] > rank[current.severity]:
                best[ex.code] = ex
        return [best[c] for c in ALLERGENS if c in best]

    def pending_confirmations(self) -> list[str]:
        return [ex.code for ex in self.exclusions if ex.severity == "needs_confirmation"]


@dataclass
class DietaryCheck:
    eligible: bool
    reasons: list[str] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)


def source_label(allergens: dict[str, Any]) -> str:
    status = allergens.get("status", "missing")
    if status == "verified":
        who = allergens.get("verified_by") or "the shop"
        when = _day(allergens.get("verified_at") or "")
        return f"Verified by {who}{' at the shop' if who != 'the shop' else ''}{(' on ' + when) if when else ''}"
    if status == "needs_review":
        return "Merchant allergen status requires review"
    return "No allergen information supplied"


def _day(value: str) -> str:
    """'2026-11-05' (or a timestamp) as 'Nov 5, 2026'; anything else as given."""
    try:
        day = date.fromisoformat(value[:10])
    except ValueError:
        return value
    return f"{day:%b} {day.day}, {day.year}"


def check_dietary(allergens: dict[str, Any], attributes: dict[str, Any], intent: Intent) -> DietaryCheck:
    status = allergens.get("status", "missing")
    contains = set(allergens.get("contains", []))
    cross = set(allergens.get("cross_contact", []))
    result = DietaryCheck(eligible=True)
    for ex in intent.exclusions:
        label = ALLERGEN_LABELS[ex.code]
        if ex.code in contains:
            result.eligible = False
            result.reasons.append(f"Contains {label}")
            result.evidence.append({"code": ex.code, "status": "contains"})
        elif ex.is_strict and status != "verified":
            result.eligible = False
            result.reasons.append(f"Allergen information not merchant-verified, so it can't meet a strict {label} exclusion")
            result.evidence.append({"code": ex.code, "status": "unverified"})
        elif ex.is_strict and ex.code in cross:
            result.eligible = False
            result.reasons.append(f"May contain {label} (cross-contact)")
            result.evidence.append({"code": ex.code, "status": "may_contain"})
        elif status != "verified":
            result.evidence.append({"code": ex.code, "status": "unverified_preference"})
        elif ex.code in cross:
            result.evidence.append({"code": ex.code, "status": "may_contain_preference"})
        else:
            result.evidence.append({"code": ex.code, "status": "verified_free"})
    diet = attributes.get("dietary", {}) or {}
    for code in intent.dietary:
        if diet.get(code) is not True or status != "verified":
            result.eligible = False
            result.reasons.append(f"Not merchant-verified as {code}")
            result.evidence.append({"code": code, "status": "unverified_diet"})
        else:
            result.evidence.append({"code": code, "status": "verified_diet"})
    return result
