"""Merchant console: the pickup queue, order detail, packing, handoff, refunds, cancellations and support replies."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.deps import rate_limit, staff_role
from app.services import fulfillment, refunds
from app.services.access import StaffContext

router = APIRouter(prefix="/api/merchant", tags=["merchant"])


class HandoffRequest(BaseModel):
    pickup_code: str = Field(min_length=4, max_length=12)


class DeclineRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


class ReplyRequest(BaseModel):
    reply: str = Field(min_length=1, max_length=1000)


@router.get("/orders")
def order_queue(status: str | None = None, slot_id: str | None = None, ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    """Pickup queue grouped by fulfillment state; payment and fulfillment are separate fields."""
    return fulfillment.order_queue(ctx, status, slot_id)


@router.get("/orders/{order_id}")
def order_detail(order_id: str, ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    return fulfillment.order_detail(ctx, order_id)


@router.post("/orders/{order_id}/fulfillment")
def update_fulfillment(order_id: str, req: fulfillment.FulfillmentAction, ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    return fulfillment.fulfillment(ctx, order_id, req)


@router.post("/orders/{order_id}/handoff", dependencies=[Depends(rate_limit("handoff", 30))])
def handoff(order_id: str, req: HandoffRequest, ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    """Verify the pickup code and complete fulfillment (staff action; no model involved)."""
    return fulfillment.handoff(ctx, order_id, req.pickup_code)


@router.post("/orders/{order_id}/refund")
def refund(order_id: str, req: refunds.RefundRequest, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    refunds.refund_order(ctx, order_id, req)
    return fulfillment.order_detail(ctx, order_id)


@router.post("/orders/{order_id}/cancel-request/decline")
def decline(order_id: str, req: DeclineRequest, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return fulfillment.decline_cancellation(ctx, order_id, req.reason)


@router.post("/support/{request_id}/reply")
def reply(request_id: str, req: ReplyRequest, ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    return fulfillment.reply_support(ctx, request_id, req.reply)
