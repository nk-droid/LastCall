"""Merchant console: the Today overview and insights (every metric shows its numerator, denominator and definition)."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends

from app.api.deps import staff_role
from app.services import insights, overview
from app.services.access import StaffContext

router = APIRouter(prefix="/api/merchant", tags=["merchant"])


@router.get("/overview")
def today(ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    return overview.today(ctx)


@router.get("/insights")
def merchant_insights(period: Literal["today", "7d"] = "today", ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    return insights.latest(ctx.merchant_id, period)


@router.get("/insights/summary")
def merchant_insights_summary(period: Literal["7d", "30d"] = "7d", ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    return insights.summary(ctx.merchant_id, period)
