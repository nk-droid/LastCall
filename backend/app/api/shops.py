"""Shop onboarding and settings for the merchant console."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import current_user, rate_limit, staff_role
from app.services import shops
from app.services.access import StaffContext
from app.services.accounts import SessionUser

router = APIRouter(prefix="/api", tags=["merchant"])


class PausedBody(BaseModel):
    paused: bool


@router.post("/shops", status_code=201, dependencies=[Depends(rate_limit("create_shop", 5, 3600))])
def create_shop(body: shops.ShopProfile, user: SessionUser = Depends(current_user)) -> dict[str, Any]:
    return shops.create(user, body)


@router.get("/merchant/shop")
def get_shop(ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    return shops.get(ctx)


@router.put("/merchant/shop/profile")
def update_profile(body: shops.ShopProfile, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return shops.update_profile(ctx, body)


@router.put("/merchant/shop/hours")
def update_hours(body: shops.HoursBody, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return shops.update_hours(ctx, body)


@router.put("/merchant/shop/pickup-paused")
def pickup_paused(body: PausedBody, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return shops.set_pickup_paused(ctx, body.paused)


@router.patch("/merchant/shop/policies")
def update_policies(body: dict[str, Any], ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return shops.update_policies(ctx, body)


@router.post("/merchant/shop/policies/confirm")
def confirm_policies(ctx: StaffContext = Depends(staff_role("owner"))) -> dict[str, Any]:
    return shops.confirm_policies(ctx)


@router.post("/merchant/shop/submit")
def submit(ctx: StaffContext = Depends(staff_role("owner"))) -> dict[str, Any]:
    return shops.submit(ctx)
