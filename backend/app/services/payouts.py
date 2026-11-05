"""A shop's PayPal payout account: where its customers' payments go.

The owner enters the PayPal business account's merchant ID (Account settings -> Business
information) or its email. Before saving, LastCall creates a small test order with that payee:
PayPal rejects unknown or unusable payees up front, and an order nobody approves simply expires,
so no money moves. Only a verified ("connected") account is used at checkout.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, EmailStr, Field, model_validator

from app import clock
from app.db import transaction
from app.errors import ProviderError, Unprocessable
from app.ids import new_request_id
from app.models import Merchant
from app.payments import get_client
from app.payments.base import PayPalError, PayPalOutcomeUnknown
from app.payments.payee import MERCHANT_ID, payee_object
from app.services import audit
from app.services.access import StaffContext, require_role
from app.services.shops import shop_view


class PayoutAccount(BaseModel):
    merchant_id: str | None = Field(default=None, max_length=13)
    email: EmailStr | None = None

    @model_validator(mode="after")
    def _one(self) -> PayoutAccount:
        if self.merchant_id:
            self.merchant_id = self.merchant_id.strip().upper()
            if not MERCHANT_ID.match(self.merchant_id):
                raise ValueError("A PayPal merchant ID is 13 letters and digits")
        if not self.merchant_id and not self.email:
            raise ValueError("Enter your PayPal merchant ID or the email of your PayPal business account")
        return self


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
    payee = {"merchant_id": account.merchant_id} if account.merchant_id else {"email": str(account.email)}
    _verify(payee)  # outside the transaction: never hold row locks across a network call
    with transaction() as db:
        merchant = db.get(Merchant, ctx.merchant_id, with_for_update=True)
        merchant.paypal = {**payee, "status": "connected", "verified_at": clock.iso(clock.now()), "connected_by": ctx.display_name}
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="merchant", entity_id=merchant.id, action="payout_account_connected",
                     meta={"kind": next(iter(payee))})
        return shop_view(db, merchant, ctx.role)


def disconnect(ctx: StaffContext) -> dict[str, Any]:
    require_role(ctx, "owner")
    with transaction() as db:
        merchant = db.get(Merchant, ctx.merchant_id, with_for_update=True)
        if merchant.status == "live":
            raise Unprocessable("A live shop needs a payout account. Connect a different account instead.", code="payout_required")
        merchant.paypal = {}
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="merchant", entity_id=merchant.id, action="payout_account_removed")
        return shop_view(db, merchant, ctx.role)
