"""Platform operations, limited to LastCall administrators: shop review and approval."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.deps import platform_admin
from app.services import shops
from app.services.accounts import SessionUser

router = APIRouter(prefix="/api/ops", tags=["ops"])


class ApproveBody(BaseModel):
    checks: list[str]


class NoteBody(BaseModel):
    note: str = Field(min_length=3, max_length=1000)


@router.get("/shops")
def shop_queue(status: str | None = None, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.review_queue(status)


@router.get("/shops/{merchant_id}")
def shop_detail(merchant_id: str, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.review_detail(merchant_id)


@router.post("/shops/{merchant_id}/approve")
def approve(merchant_id: str, body: ApproveBody, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.approve(admin, merchant_id, body.checks)


@router.post("/shops/{merchant_id}/reject")
def reject(merchant_id: str, body: NoteBody, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.reject(admin, merchant_id, body.note)


@router.post("/shops/{merchant_id}/suspend")
def suspend(merchant_id: str, body: NoteBody, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.suspend(admin, merchant_id, body.note)


@router.post("/shops/{merchant_id}/reinstate")
def reinstate(merchant_id: str, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.reinstate(admin, merchant_id)
