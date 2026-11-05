"""Merchant console: order actions. Refunds need a manager and go through PayPal's Payments API."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.api.deps import staff_role
from app.services import refunds
from app.services.access import StaffContext

router = APIRouter(prefix="/api/merchant/orders", tags=["merchant"])


@router.post("/{order_id}/refund")
def refund(order_id: str, req: refunds.RefundRequest, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return refunds.refund_order(ctx, order_id, req)
