"""Customer order endpoints: my orders, status and pickup pass, cancellation requests, help messages.

An order is visible to the browser session that placed it, to the signed-in shopper it belongs
to, or to anyone holding its private order link (an access token, stored hashed).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field

from app.api.deps import optional_shopper_session, optional_user, rate_limit
from app.services import orders
from app.services.accounts import SessionUser

router = APIRouter(prefix="/api", tags=["orders"])


def _uid(user: SessionUser | None) -> str | None:
    return user.user_id if user else None


@router.get("/me/orders")
def my_orders(session_id: str | None = Depends(optional_shopper_session), user: SessionUser | None = Depends(optional_user)) -> dict[str, Any]:
    """A signed-in shopper's orders at every shop; for a guest, this browser session's orders."""
    return orders.customer_orders(session_id, _uid(user))


@router.get("/orders/{order_id}")
def get_order(order_id: str, session_id: str | None = Depends(optional_shopper_session), user: SessionUser | None = Depends(optional_user),
              x_order_token: str | None = Header(default=None), t: str | None = Query(default=None, max_length=80)) -> dict[str, Any]:
    return orders.customer_view_by_id(order_id, session_id=session_id, access_token=x_order_token or t, user_id=_uid(user))


class CancelRequest(BaseModel):
    reason: str = Field(default="", max_length=300)


@router.post("/orders/{order_id}/cancel-request")
def cancel_request(order_id: str, req: CancelRequest, session_id: str | None = Depends(optional_shopper_session),
                   user: SessionUser | None = Depends(optional_user), x_order_token: str | None = Header(default=None)) -> dict[str, Any]:
    """Merchant-policy cancellation workflow: the request is reviewed; refunds follow provider confirmation."""
    return orders.request_cancellation(order_id, req.reason, session_id=session_id, access_token=x_order_token, user_id=_uid(user))


@router.post("/orders/{order_id}/cancel")
def cancel_unpaid(order_id: str, session_id: str | None = Depends(optional_shopper_session), user: SessionUser | None = Depends(optional_user),
                  x_order_token: str | None = Header(default=None)) -> dict[str, Any]:
    return orders.cancel_unpaid(order_id, session_id=session_id, access_token=x_order_token, user_id=_uid(user))


class SupportMessage(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    topic: str = Field(default="general", max_length=40)


@router.post("/orders/{order_id}/support", dependencies=[Depends(rate_limit("support", 10))])
def support(order_id: str, req: SupportMessage, session_id: str | None = Depends(optional_shopper_session),
            user: SessionUser | None = Depends(optional_user), x_order_token: str | None = Header(default=None)) -> dict[str, Any]:
    return orders.support_message(order_id, req.message, req.topic, session_id=session_id, access_token=x_order_token, user_id=_uid(user))
