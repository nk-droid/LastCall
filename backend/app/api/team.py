"""Merchant console: the shop's team, roles and invitations."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr

from app.api.deps import staff_role
from app.services import team
from app.services.access import StaffContext

router = APIRouter(prefix="/api/merchant/team", tags=["merchant"])

Role = Literal["staff", "manager", "owner"]


class InviteBody(BaseModel):
    email: EmailStr
    role: Role = "staff"


class RoleBody(BaseModel):
    role: Role


@router.get("")
def list_team(ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return team.team(ctx)


@router.post("/invites", status_code=201)
def create_invite(body: InviteBody, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return team.invite(ctx, body.email, body.role)


@router.delete("/invites/{invite_id}")
def revoke_invite(invite_id: str, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, bool]:
    team.revoke_invite(ctx, invite_id)
    return {"ok": True}


@router.patch("/members/{membership_id}")
def change_role(membership_id: str, body: RoleBody, ctx: StaffContext = Depends(staff_role("owner"))) -> dict[str, Any]:
    return team.change_role(ctx, membership_id, body.role)


@router.delete("/members/{membership_id}")
def remove_member(membership_id: str, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return team.remove(ctx, membership_id)


@router.post("/members/{membership_id}/reset-link")
def reset_link(membership_id: str, ctx: StaffContext = Depends(staff_role("owner"))) -> dict[str, str]:
    return team.reset_link(ctx, membership_id)
