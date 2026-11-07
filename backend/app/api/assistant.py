"""The shop's AI teammates page: what the agents did for this shop this week."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.api.deps import staff_role
from app.services import assistant
from app.services.access import StaffContext

router = APIRouter(prefix="/api/merchant", tags=["assistant"])


@router.get("/assistant")
def activity(ctx: StaffContext = Depends(staff_role("staff"))) -> dict[str, Any]:
    return assistant.activity(ctx)
