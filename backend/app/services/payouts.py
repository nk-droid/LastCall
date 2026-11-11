"""A shop's PayPal payout account: where its customers' payments go.

The owner either signs in with PayPal ("Connect with PayPal", Log in with PayPal: PayPal tells us the
account's payer ID, which is its merchant ID, and whether it's verified) or enters the business
account's merchant ID (Account settings -> Business information). Either way, before saving, LastCall creates a small test order with that payee: PayPal rejects
unknown or unusable merchant IDs up front (PAYEE_ACCOUNT_INVALID), and an order nobody approves
simply expires, so no money moves. Emails aren't accepted: PayPal takes any email as a payee at
order creation, so an email can't be verified and a typo would send money to an unclaimed account.
Only a verified ("connected") account is used at checkout.
"""

from __future__ import annotations

import base64
import hmac
import secrets
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app import clock
from app.config import settings
from app.db import transaction
from app.errors import ProviderError, Unprocessable
from app.ids import new_request_id
from app.models import Merchant
from app.payments import get_client
from app.payments.base import PayPalError, PayPalOutcomeUnknown
from app.payments.payee import MERCHANT_ID, payee_object
from app.security import token_hash
from app.services import audit
from app.services.access import StaffContext, require_role
from app.services.shops import shop_view


class PayoutAccount(BaseModel):
    merchant_id: str = Field(min_length=1, max_length=20)

    @field_validator("merchant_id")
    @classmethod
    def _format(cls, value: str) -> str:
        value = value.strip().upper()
        if not MERCHANT_ID.match(value):
            raise ValueError("A PayPal merchant ID is 13 letters and digits (PayPal: Account settings -> Business information)")
        return value


def _verify(payee: dict[str, str]) -> None:
    body = {
        "intent": "CAPTURE",
        "purchase_units": [{"reference_id": "payout-check", "description": "LastCall payout account check (never captured)",
                            "payee": payee_object(payee), "amount": {"currency_code": "USD", "value": "1.00"}}],
    }
    try:
        get_client().create_order(body, new_request_id())
    except PayPalError as exc:
        if exc.status in (400, 422):
            raise Unprocessable("PayPal didn't accept that account for payments. Check the merchant ID or email.",
                                code="payee_invalid", details={"issue": exc.issue}) from exc
        raise ProviderError("PayPal couldn't check the account right now; try again shortly", code="payee_check_failed") from exc
    except PayPalOutcomeUnknown as exc:
        raise ProviderError("PayPal couldn't check the account right now; try again shortly", code="payee_check_failed") from exc


def connect(ctx: StaffContext, account: PayoutAccount) -> dict[str, Any]:
    require_role(ctx, "owner")
    return _save(ctx, account.merchant_id, via="merchant_id")


def _save(ctx: StaffContext, merchant_id: str, *, via: str, email: str | None = None) -> dict[str, Any]:
    payee = {"merchant_id": merchant_id}
    _verify(payee)  # outside the transaction: never hold row locks across a network call
    with transaction() as db:
        merchant = db.get(Merchant, ctx.merchant_id, with_for_update=True)
        merchant.paypal = {**payee, "status": "connected", "verified_at": clock.iso(clock.now()), "connected_by": ctx.display_name,
                           "connected_via": via, **({"email": _mask(email)} if email else {})}
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="merchant", entity_id=merchant.id, action="payout_account_connected",
                     meta={"merchant_id": merchant_id, "via": via})
        return shop_view(db, merchant, ctx.role)


# --------------------------------------------------------------------------- Connect with PayPal (Log in with PayPal)

CONNECT_SECONDS = 600


class ConnectFinish(BaseModel):
    code: str = Field(min_length=4, max_length=2000)
    state: str = Field(min_length=10, max_length=400)


def return_url() -> str:
    return f"{settings().public_app_url.rstrip('/')}/merchant/paypal/return"


def connect_start(ctx: StaffContext) -> dict[str, Any]:
    """Where to send the owner to sign in with PayPal. The state ties the sign-in to this shop and this owner for ten minutes."""
    require_role(ctx, "owner")
    if not settings().paypal_connect_enabled:
        raise Unprocessable("Connect with PayPal isn't turned on here. Enter your merchant ID instead.", code="paypal_connect_off")
    return {"url": get_client().login_url(_state(ctx), return_url())}


def connect_finish(ctx: StaffContext, req: ConnectFinish) -> dict[str, Any]:
    """PayPal sent the owner back: read who signed in and connect that account."""
    require_role(ctx, "owner")
    if not settings().paypal_connect_enabled:
        raise Unprocessable("Connect with PayPal isn't turned on here. Enter your merchant ID instead.", code="paypal_connect_off")
    _check_state(req.state, ctx)
    try:
        who = get_client().login_identity(req.code)
    except PayPalError as exc:
        raise Unprocessable("PayPal didn't finish connecting your account. Try again.", code="paypal_connect_failed",
                            details={"issue": exc.issue}) from exc
    except PayPalOutcomeUnknown as exc:
        raise ProviderError("PayPal couldn't be reached; try again shortly", code="paypal_connect_unreachable") from exc
    payer_id = (who.get("payer_id") or "").upper()
    if not MERCHANT_ID.match(payer_id):
        raise Unprocessable("PayPal didn't share the account's ID. Try again, or enter your merchant ID instead.", code="paypal_connect_failed")
    if not who.get("verified"):
        raise Unprocessable("That PayPal account isn't verified yet. Verify it with PayPal, then connect again.", code="paypal_unverified")
    return _save(ctx, payer_id, via="paypal", email=who.get("email"))


def _state(ctx: StaffContext) -> str:
    body = f"{ctx.merchant_id}|{ctx.id}|{int(clock.now().timestamp()) + CONNECT_SECONDS}|{secrets.token_urlsafe(9)}"
    encoded = base64.urlsafe_b64encode(body.encode()).decode().rstrip("=")
    return f"{encoded}.{token_hash(body, 'paypal-connect')[:32]}"


def _check_state(state: str, ctx: StaffContext) -> None:
    try:
        encoded, signature = state.rsplit(".", 1)
        body = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode()
        merchant_id, user_id, expires, _ = body.split("|")
        valid = hmac.compare_digest(signature, token_hash(body, "paypal-connect")[:32])
    except (ValueError, UnicodeDecodeError) as exc:
        raise Unprocessable("That PayPal sign-in link isn't valid. Start again from Payouts.", code="paypal_connect_invalid") from exc
    if not valid or merchant_id != ctx.merchant_id or user_id != ctx.id:
        raise Unprocessable("That PayPal sign-in was started for a different shop or person. Start again from Payouts.", code="paypal_connect_invalid")
    if int(expires) < clock.now().timestamp():
        raise Unprocessable("That PayPal sign-in took too long. Start again from Payouts.", code="paypal_connect_expired")


def _mask(email: str) -> str:
    name, _, domain = email.partition("@")
    return f"{name[:2]}…@{domain}" if domain else ""


def disconnect(ctx: StaffContext) -> dict[str, Any]:
    require_role(ctx, "owner")
    with transaction() as db:
        merchant = db.get(Merchant, ctx.merchant_id, with_for_update=True)
        if merchant.status == "live":
            raise Unprocessable("A live shop needs a payout account. Connect a different account instead.", code="payout_required")
        merchant.paypal = {}
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="merchant", entity_id=merchant.id, action="payout_account_removed")
        return shop_view(db, merchant, ctx.role)
