"""Merchant console: today's stock, products, prices, alerts and pickup slots."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app import clock
from app.api.deps import staff_role
from app.db import transaction
from app.services import alerts, audit, inventory, pickup
from app.services.access import StaffContext
from app.services.catalog import merchant_by_id

router = APIRouter(prefix="/api/merchant", tags=["merchant"])


class SlotUpdate(BaseModel):
    capacity: int | None = Field(default=None, ge=0, le=100)
    status: Literal["open", "closed"] | None = None


@router.get("/inventory")
def list_inventory(ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    with transaction() as db:
        merchant = merchant_by_id(db, ctx.merchant_id)
        now = clock.now()
        return {"rows": inventory.inventory_rows(db, merchant, now), "as_of": clock.iso(now), "timezone": merchant.timezone,
                "currency": merchant.currency, "alerts": alerts.open_alerts(db, merchant.id)}


@router.post("/inventory")
def update_inventory(req: inventory.InventoryUpdate, ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    """Authorized stock update: writes an inventory event; held stock can't be double-sold."""
    return {"row": inventory.update_inventory(ctx, req)}


@router.post("/products", status_code=201)
def create_product(req: inventory.NewProduct, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return {"row": inventory.create_product(ctx, req)}


@router.put("/products/{product_id}")
def update_product(product_id: str, req: inventory.ProductInput, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return {"row": inventory.update_product(ctx, product_id, req)}


@router.post("/products/{product_id}/price")
def set_price(product_id: str, req: inventory.PriceInput, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    return {"row": inventory.set_price(ctx, product_id, req)}


@router.get("/products/{product_id}/history")
def product_history(product_id: str, ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    return inventory.product_history(ctx, product_id)


@router.post("/alerts/{alert_id}/resolve")
def resolve_alert(alert_id: str, ctx: StaffContext = Depends(staff_role())) -> dict[str, str]:
    alerts.resolve_by_id(ctx, alert_id)
    return {"status": "resolved"}


@router.get("/slots")
def list_slots(ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    with transaction() as db:
        merchant = merchant_by_id(db, ctx.merchant_id)
        now = clock.now()
        pickup.ensure_slots(db, merchant, now)
        return {"slots": [pickup.slot_view(s, merchant, now) for s in pickup.list_slots(db, merchant, now)], "as_of": clock.iso(now)}


@router.put("/slots/{slot_id}")
def update_slot(slot_id: str, req: SlotUpdate, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    with transaction() as db:
        merchant = merchant_by_id(db, ctx.merchant_id)
        slot = pickup.update_slot(db, merchant, slot_id, req.capacity, req.status)
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="pickup_slot", entity_id=slot.id, action="slot_updated",
                     meta={"capacity": slot.capacity, "status": slot.status, "booked": slot.booked_count})
        return pickup.slot_view(slot, merchant, clock.now())
