"""Close-out plan (A3): today's agent-proposed end-of-day changes for the shop, applied by a manager."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.deps import rate_limit, staff_role
from app.services import closeout
from app.services.access import StaffContext

router = APIRouter(prefix="/api/merchant", tags=["closeout"])


class ApplyRequest(BaseModel):
    # Omit to apply every suggested change.
    action_ids: list[str] | None = Field(default=None, max_length=20)


@router.get("/closeout")
def get_plan(ctx: StaffContext = Depends(staff_role("staff"))) -> dict[str, Any]:
    return closeout.current(ctx)


@router.post("/closeout/run", dependencies=[Depends(rate_limit("agent", 10))])
def run_now(ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return closeout.run_now(ctx)


@router.post("/closeout/{plan_id}/apply")
def apply(plan_id: str, req: ApplyRequest, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return closeout.apply(ctx, plan_id, req.action_ids)


@router.post("/closeout/{plan_id}/dismiss")
def dismiss(plan_id: str, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return closeout.dismiss(ctx, plan_id)
