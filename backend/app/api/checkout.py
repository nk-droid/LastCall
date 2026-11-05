"""PayPal checkout endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field

from app.api.deps import optional_shopper_session, optional_user, rate_limit, shopper_session
from app.services import checkout
from app.services.accounts import SessionUser

router = APIRouter(prefix="/api", tags=["checkout"])


def _uid(user: SessionUser | None) -> str | None:
    return user.user_id if user else None


@router.post("/checkout/paypal/order", dependencies=[Depends(rate_limit("checkout", 30))])
def create_paypal_order(req: checkout.StartCheckout, session_id: str = Depends(shopper_session),
                        user: SessionUser | None = Depends(optional_user)) -> dict[str, Any]:
    """Create the PayPal order from the server's own quote for the current, held basket."""
    return checkout.start_checkout(session_id, req, user_id=_uid(user))


class CaptureRequest(BaseModel):
    order_id: str = Field(max_length=40)
    paypal_order_id: str = Field(max_length=64)


@router.post("/checkout/paypal/capture", dependencies=[Depends(rate_limit("checkout", 30))])
def capture(req: CaptureRequest, session_id: str | None = Depends(optional_shopper_session), x_order_token: str | None = Header(default=None),
            user: SessionUser | None = Depends(optional_user)) -> dict[str, Any]:
    """Capture server-side after buyer approval; the order is 'paid' only after a verified capture."""
    return checkout.capture(req.order_id, req.paypal_order_id, session_id=session_id, access_token=x_order_token, user_id=_uid(user))
