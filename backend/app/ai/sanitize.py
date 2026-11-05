"""Guards on model text before a customer or merchant sees it.

Dietary/allergen facts, prices and stock urgency are always rendered from merchant data by
code, so model prose that asserts them is dropped sentence by sentence.
"""

from __future__ import annotations

import re

from app.domain import ALLERGEN_KEYWORDS, allergen_mentions, mentions_free_from_claim

_SENTENCE = re.compile(r"(?<=[.!?])\s+")
_MONEY = re.compile(r"(?:[$€£]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d+(?:\.\d{2})\s?(?:usd|dollars?)\b|\b\d+\s?(?:%|percent)\b)", re.IGNORECASE)
_URGENCY = re.compile(
    r"\b(hurry|act fast|selling fast|going fast|last chance|only \d+ left|limited time|don'?t miss|before it'?s gone|people (?:are )?viewing)\b",
    re.IGNORECASE,
)
_SAFETY = re.compile(r"\b(allerg\w*|safe|safety|celiac|anaphyla\w*|gluten|vegan|vegetarian|dairy|lactose)\b", re.IGNORECASE)
_ALLERGEN_WORDS = "|".join(sorted({re.escape(w) for words in ALLERGEN_KEYWORDS.values() for w in words}, key=len, reverse=True))
_NEGATED_ALLERGEN = re.compile(
    rf"\b(?:without|no|zero|free of|free from|minus|skips?|avoids?)\s+(?:any\s+)?(?:{_ALLERGEN_WORDS})", re.IGNORECASE
)

_INJECTION = re.compile(
    r"(ignore (?:all |any |the )?(?:previous|prior|above|earlier|system)|disregard (?:all |the )?(?:rules|instructions)|"
    r"system prompt|you are now|new instructions|override|jailbreak|set (?:the )?(?:price|budget|total)|"
    r"mark (?:this|it) as (?:safe|nut[- ]free|allergen[- ]free)|developer mode)",
    re.IGNORECASE,
)


def looks_like_injection(text: str) -> bool:
    return bool(_INJECTION.search(text or ""))


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(text.strip()) if s.strip()]


def clean_customer_prose(text: str, *, allowed_amounts: set[str] | None = None, max_chars: int = 220) -> str:
    """Keep only sentences that make no dietary, safety, price or urgency claims."""
    allowed_amounts = allowed_amounts or set()
    kept: list[str] = []
    for sentence in _sentences(text):
        if _SAFETY.search(sentence) or mentions_free_from_claim(sentence) or _NEGATED_ALLERGEN.search(sentence):
            continue
        if _URGENCY.search(sentence) or looks_like_injection(sentence):
            continue
        amounts = set(m.group(0).replace(" ", "") for m in _MONEY.finditer(sentence))
        if amounts and not amounts <= allowed_amounts:
            continue
        kept.append(sentence)
    result = " ".join(kept)
    if len(result) > max_chars:
        cut = result[:max_chars].rsplit(" ", 1)[0].rstrip(",;:")
        result = cut + "…"
    return result


def clean_merchant_copy(text: str, contains: set[str], max_chars: int = 320) -> tuple[str, list[str]]:
    """Drop sentences in an AI product-copy draft that name allergens the merchant did not list
    or that make free-from/safety claims. Returns the cleaned draft and what was removed."""
    removed: list[str] = []
    kept: list[str] = []
    for sentence in _sentences(text):
        mentioned = allergen_mentions(sentence)
        if mentioned - contains:
            removed.append(f"Mentioned {', '.join(sorted(mentioned - contains))} which isn't in your ingredient list")
            continue
        if mentions_free_from_claim(sentence) or _SAFETY.search(sentence) or _NEGATED_ALLERGEN.search(sentence):
            removed.append("Made a dietary or safety claim")
            continue
        if _MONEY.search(sentence) or _URGENCY.search(sentence):
            removed.append("Mentioned price or urgency")
            continue
        kept.append(sentence)
    result = " ".join(kept)
    return result[:max_chars], removed
