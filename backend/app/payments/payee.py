"""Paying each shop's own PayPal account.

Checkout names the shop as ``purchase_units[].payee`` by its PayPal merchant ID, so the buyer
pays the shop directly while LastCall's app creates and captures the order. Acting on that
money afterwards (refunds, lookups) is done on the shop's behalf, which PayPal requires to be
declared with a ``PayPal-Auth-Assertion`` header: an unsigned JWT naming our client ID and the
payee. The payee is snapshotted on each payment attempt, so a later change to a shop's payout
account never redirects a refund.
"""

from __future__ import annotations

import base64
import json
import re
from typing import Any

MERCHANT_ID = re.compile(r"^[A-Z0-9]{13}$")


def _b64(value: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")


def payee_object(payee: dict[str, Any] | None) -> dict[str, str] | None:
    """The ``payee`` field for a purchase unit, or None to pay the platform account."""
    return {"merchant_id": payee["merchant_id"]} if payee and payee.get("merchant_id") else None


def auth_assertion(client_id: str, payee: dict[str, Any] | None) -> str | None:
    """``PayPal-Auth-Assertion`` value for acting on a payee's transaction (None for the platform's own)."""
    if not payee or not payee.get("merchant_id"):
        return None
    return f"{_b64({'alg': 'none'})}.{_b64({'iss': client_id, 'payer_id': payee['merchant_id']})}."


def display(paypal: dict[str, Any]) -> dict[str, Any]:
    """What the console shows about the payout account (never the full identifier for staff)."""
    if not paypal:
        return {"status": "not_connected"}
    ident = paypal.get("merchant_id") or ""
    return {"status": paypal.get("status", "not_connected"), "display": f"{ident[:3]}…{ident[-3:]}" if len(ident) > 8 else ident,
            "verified_at": paypal.get("verified_at"), "via": paypal.get("connected_via", "merchant_id"), "email": paypal.get("email")}
