"""Merchant console: today's stock, products, prices, alerts and pickup slots."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, UploadFile
from pydantic import BaseModel, Field

from app import clock
from app.api.deps import rate_limit, staff_role
from app.db import transaction
from app.services import alerts, audit, copywriter, inventory, listings, media, pickup
from app.services.access import StaffContext
from app.services.catalog import merchant_by_id

router = APIRouter(prefix="/api/merchant", tags=["merchant"])


class CopyRequest(BaseModel):
    notes: str = Field(default="", max_length=300)


class SlotUpdate(BaseModel):
    capacity: int | None = Field(default=None, ge=0, le=100)
    status: Literal["open", "closed"] | None = None


@router.get("/inventory")
def list_inventory(ctx: StaffContext = Depends(staff_role())) -> dict[str, Any]:
    with transaction() as db:
        merchant = merchant_by_id(db, ctx.merchant_id)
        now = clock.now()
        rows = inventory.inventory_rows(db, merchant, now)
        sold = inventory.sold_today(db, merchant, now)
        window = pickup.window_for(merchant, clock.local_date(merchant.timezone))
        relist = (merchant.policies or {}).get("relist_at_local")
        return {"rows": [{**r, "sold_today": sold.get(r["product_id"], 0)} for r in rows], "as_of": clock.iso(now),
                "timezone": merchant.timezone, "currency": merchant.currency, "alerts": alerts.open_alerts(db, merchant.id),
                # For the header: when "Repeat daily" items go back on sale, and when today's pickup ends.
                "schedule": {"relist_label": pickup.time_label(relist) if relist and any(r["relist"]["enabled"] for r in rows) else None,
                             "pickup_until_label": pickup.time_label(window[1]) if window else None,
                             "pickup_paused": merchant.pickup_paused}}


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


@router.post("/products/{product_id}/copy-draft", dependencies=[Depends(rate_limit("ai", 30))])
def copy_draft(product_id: str, req: CopyRequest, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    """L4 draft. It is never published until a manager saves it on the product."""
    return copywriter.draft_copy(ctx, product_id, req.notes)


@router.post("/assets", status_code=201, dependencies=[Depends(rate_limit("upload", 30, 600))])
async def upload_photo(file: UploadFile, ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    """Upload a product photo; attach it to a product by saving the returned URL as its image."""
    raw = await file.read(media.MAX_UPLOAD_BYTES + 1)
    with transaction() as db:
        asset = media.store(db, raw, filename=file.filename or "photo", merchant_id=ctx.merchant_id, actor=ctx.actor)
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="asset", entity_id=asset.id, action="photo_uploaded",
                     meta={"bytes": asset.size_bytes, "width": asset.width, "height": asset.height})
        return {"id": asset.id, "url": media.url(asset.id), "width": asset.width, "height": asset.height}


@router.post("/listings/publish")
def publish_listing(ctx: StaffContext = Depends(staff_role("manager"))) -> dict[str, Any]:
    """Re-list every 'repeat daily' product now with its template quantity."""
    return listings.relist_now(ctx)


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
