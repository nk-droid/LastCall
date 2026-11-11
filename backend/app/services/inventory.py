"""InventoryService write side: today's surplus counts, products, allergen records and prices.

Every change is authorized (manager+ for catalog data; any staff for stock counts), audited
and recorded as an inventory event. Held or paid units can never be removed by a stock edit.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.domain import ALLERGENS
from app.errors import Conflict, NotFound, Unprocessable
from app.ids import new_id
from app.models import PRODUCT_CATEGORIES, Asset, AuditEvent, BundleQuote, InventoryEvent, InventoryLot, Merchant, Order, Price, Product
from app.money import format_money
from app.services import analytics, audit, jobs, media
from app.services.access import StaffContext, require_role
from app.services.alerts import raise_alert, resolve_alerts
from app.services.catalog import (
    allergen_view,
    availability,
    availability_status,
    catalog_items,
    current_prices,
    image_view,
    list_merchants,
    lock_lots,
    merchant_by_id,
    policy,
)

ProductCategory = Literal[PRODUCT_CATEGORIES]  # type: ignore[valid-type]


def inventory_rows(db: Session, merchant: Merchant, now: datetime) -> list[dict[str, Any]]:
    products = db.scalars(select(Product).where(Product.merchant_id == merchant.id, Product.status != "archived").order_by(Product.sku)).all()
    ids = [p.id for p in products]
    avail = availability(db, merchant.id, now, ids)
    prices = current_prices(db, ids, now)
    items = {i.product_id: i for i in catalog_items(db, merchant, now, include_without_photo=True)}
    low = int(policy(merchant, "low_stock_threshold", 2))
    stale_minutes = int(policy(merchant, "stale_inventory_minutes", 240))
    rows = []
    for p in products:
        a = avail.get(p.id)
        price = prices.get(p.id)
        item = items.get(p.id)
        if a is None:
            continue
        rows.append({
            "product_id": p.id,
            "sku": p.sku,
            "name": p.name,
            "category": p.category,
            "status": p.status,
            "image": image_view(p),
            "surplus": a.surplus,
            "on_hand": a.on_hand,
            "reserved": a.reserved,
            "committed": a.committed,
            "buffer": a.buffer,
            "available": a.available,
            "availability_status": availability_status(item, now, low) if item else ("paused" if p.status != "active" else "unpriced"),
            "cutoff_at": clock.iso(a.cutoff_at),
            "cutoff_local": clock.hhmm(a.cutoff_at, merchant.timezone),
            "cutoff_label": clock.display_time(a.cutoff_at, merchant.timezone),
            "updated_at": clock.iso(a.updated_at),
            "stale": a.updated_at < now - timedelta(minutes=stale_minutes),
            "version": a.version,
            "price": {
                "currency": price.currency, "reference_minor": price.reference_minor, "sale_minor": price.sale_minor,
                "reference_source": price.reference_source, "effective_at": clock.iso(price.effective_at), "tax_category": price.tax_category,
            } if price else None,
            "allergens": allergen_view(p.allergens or {}, p.allergen_source),
            "attributes": p.attributes,
            "description": p.description,
            "description_source": p.description_source,
            "per_order_limit": p.per_order_limit,
            "surplus_priority": p.surplus_priority,
            "relist": {"enabled": p.relist_daily, "qty": p.relist_qty, "cutoff_local": p.relist_cutoff_local},
        })
    return rows


def sold_today(db: Session, merchant: Merchant, now: datetime) -> dict[str, int]:
    """Units sold per product today: paid, not cancelled, counted by when payment was confirmed."""
    day_start = clock.combine_local(clock.local_date(merchant.timezone), "00:00", merchant.timezone)
    orders = db.scalars(select(Order).where(Order.merchant_id == merchant.id, Order.payment_status == "CAPTURED",
                                            Order.fulfillment_status != "CANCELLED", Order.confirmed_at >= day_start,
                                            Order.confirmed_at <= now)).all()
    quotes = {q.id: q for q in db.scalars(select(BundleQuote).where(BundleQuote.id.in_([o.quote_id for o in orders] or [""]))).all()}
    sold: dict[str, int] = {}
    for o in orders:
        for line in quotes[o.quote_id].item_lines if o.quote_id in quotes else []:
            sold[line["product_id"]] = sold.get(line["product_id"], 0) + int(line["qty"])
    return sold


class InventoryUpdate(BaseModel):
    product_id: str
    action: Literal["adjust", "set", "counter_sale", "set_buffer", "set_cutoff", "set_on_hand", "pause", "resume", "archive", "confirm"]
    delta: int | None = Field(default=None, ge=-500, le=500)
    value: int | None = Field(default=None, ge=0, le=5000)
    cutoff_local: str | None = Field(default=None, pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    expected_version: int | None = None
    reason: str = Field(default="", max_length=200)


def update_inventory(user: StaffContext, upd: InventoryUpdate) -> dict[str, Any]:
    """Stock changes for the member's shop. Pausing, resuming and archiving listings needs a manager."""
    if upd.action in ("pause", "resume", "archive"):
        require_role(user, "manager")
    with transaction() as db:
        merchant = merchant_by_id(db, user.merchant_id)
        product = db.get(Product, upd.product_id)
        if product is None or product.merchant_id != merchant.id:
            raise NotFound("Product not found")
        lot = lock_lots(db, [product.id]).get(product.id)
        if lot is None:
            raise NotFound("No inventory lot for this product")
        now = clock.now()
        if upd.expected_version is not None and upd.expected_version != lot.version:
            current = next((r for r in inventory_rows(db, merchant, now) if r["product_id"] == product.id), None)
            raise Conflict("Stock changed since you loaded it", code="version_conflict", details={"current": current})
        a = availability(db, merchant.id, now, [product.id])[product.id]
        held = a.reserved + a.committed
        before = lot.surplus_qty
        event_type = None
        delta = 0
        if upd.action in ("adjust", "counter_sale", "set"):
            if upd.action == "set":
                if upd.value is None:
                    raise Unprocessable("value is required", code="value_required")
                new = upd.value
            else:
                if upd.delta is None:
                    raise Unprocessable("delta is required", code="delta_required")
                new = before + (-abs(upd.delta) if upd.action == "counter_sale" else upd.delta)
            if new < 0:
                raise Unprocessable("Surplus can't be negative", code="negative_stock")
            if new < held:
                raise Conflict(
                    f"{held} unit(s) are held by active reservations or paid orders, so surplus can't go below {held}. "
                    "Cancel or fulfill those orders first.",
                    code="held_stock", details={"held": held, "requested": new},
                )
            lot.surplus_qty = new
            lot.on_hand = max(lot.on_hand + (new - before), new)
            delta = new - before
            event_type = "COUNTER_SALE" if upd.action == "counter_sale" else ("LISTED" if delta > 0 else "ADJUSTED")
            if a.available > 0 and max(0, new - held - lot.buffer_qty) == 0:
                analytics.track(db, "stockout", merchant_id=merchant.id, entity_type="product", entity_id=product.id,
                                properties={"sku": product.sku, "via": upd.action})
        elif upd.action == "set_buffer":
            if upd.value is None:
                raise Unprocessable("value is required", code="value_required")
            lot.buffer_qty = upd.value
            event_type = "BUFFER_CHANGED"
        elif upd.action == "set_on_hand":
            if upd.value is None or upd.value < lot.surplus_qty:
                raise Unprocessable("On-hand must be at least the surplus listed", code="invalid_on_hand")
            lot.on_hand = upd.value
            event_type = "ON_HAND_CHANGED"
        elif upd.action == "set_cutoff":
            if not upd.cutoff_local:
                raise Unprocessable("cutoff_local is required", code="cutoff_required")
            lot.cutoff_at = clock.combine_local(clock.local_date(merchant.timezone), upd.cutoff_local, merchant.timezone)
            event_type = "CUTOFF_CHANGED"
        elif upd.action == "confirm":
            # "Count is right": nothing changes but the time it was last checked, so it stops showing as stale.
            event_type = "COUNT_CONFIRMED"
        elif upd.action in ("pause", "resume"):
            product.status = "paused" if upd.action == "pause" else "active"
            event_type = "PAUSED" if upd.action == "pause" else "RESUMED"
        elif upd.action == "archive":
            if held:
                raise Conflict(f"{held} unit(s) are held by active orders; archive after they're fulfilled", code="held_stock",
                               details={"held": held})
            product.status = "archived"
            event_type = "ARCHIVED"
        lot.version += 1
        lot.updated_at = now
        lot.updated_by = user.actor
        db.add(InventoryEvent(merchant_id=merchant.id, product_id=product.id, sku=product.sku, event_type=event_type or upd.action.upper(),
                              delta=delta, surplus_before=before, surplus_after=lot.surplus_qty, actor=user.actor,
                              reason=upd.reason or upd.action.replace("_", " "), created_at=now))
        if event_type in ("LISTED", "RESUMED"):  # new stock may fit a shopper's watch
            jobs.enqueue("watches.scan", {"merchant_id": merchant.id}, delay_seconds=15, dedupe_key=f"watches.scan:{merchant.id}", db=db)
        audit.record(db, actor=user.actor, actor_role=user.role, entity_type="product", entity_id=product.id,
                     action=f"inventory_{upd.action}", meta={"before": before, "after": lot.surplus_qty, "buffer": lot.buffer_qty,
                                                             "cutoff_at": clock.iso(lot.cutoff_at), "reason": upd.reason})
        resolve_alerts(db, merchant.id, "stale_inventory", product.id)
        db.flush()
        if product.status == "archived":
            return {"product_id": product.id, "status": "archived"}
        return next(r for r in inventory_rows(db, merchant, now) if r["product_id"] == product.id)


class AllergenInput(BaseModel):
    contains: list[str] = Field(default_factory=list)
    cross_contact: list[str] = Field(default_factory=list)
    status: Literal["verified", "needs_review", "missing"]
    notes: str = Field(default="", max_length=300)

    @field_validator("contains", "cross_contact")
    @classmethod
    def _known(cls, value: list[str]) -> list[str]:
        unknown = [v for v in value if v not in ALLERGENS]
        if unknown:
            raise ValueError(f"Unknown allergen codes: {', '.join(unknown)}")
        return sorted(set(value))


class RelistInput(BaseModel):
    enabled: bool = False
    qty: int = Field(default=0, ge=0, le=500)
    cutoff_local: str | None = Field(default=None, pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")


class ProductInput(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=600)
    description_source: Literal["merchant", "ai_draft_approved"] = "merchant"
    category: ProductCategory
    flavor: Literal["sweet", "savory"]
    servings_per_unit: float = Field(ge=0.5, le=12)
    tags: list[str] = Field(default_factory=list, max_length=8)
    ingredients: str = Field(default="", max_length=600)
    dietary: dict[str, bool | None] = Field(default_factory=dict)
    allergens: AllergenInput
    per_order_limit: int = Field(ge=1, le=24)
    surplus_priority: int = Field(ge=0, le=3)
    image_url: str | None = Field(default=None, max_length=500)
    relist: RelistInput | None = None

    @field_validator("image_url")
    @classmethod
    def _image(cls, value: str | None) -> str | None:
        if value and not value.startswith("/api/assets/"):
            raise ValueError("Upload a photo for this product")
        return value or None


def _apply_product(product: Product, data: ProductInput, user: StaffContext) -> None:
    product.name = data.name
    product.description = data.description
    product.description_source = data.description_source
    product.category = data.category
    product.attributes = {
        **(product.attributes or {}),
        "flavor": data.flavor,
        "servings_per_unit": data.servings_per_unit,
        "tags": data.tags,
        "ingredients": data.ingredients,
        "dietary": {k: v for k, v in data.dietary.items() if k in ("vegetarian", "vegan")},
    }
    previous = product.allergens or {}
    allergens = data.allergens.model_dump()
    changed = any(previous.get(k) != allergens.get(k) for k in ("contains", "cross_contact", "status"))
    if allergens["status"] == "verified" and (changed or previous.get("status") != "verified"):
        allergens["verified_by"] = user.display_name
        allergens["verified_at"] = clock.local_date("UTC").isoformat()
    elif allergens["status"] == "verified":
        allergens["verified_by"] = previous.get("verified_by")
        allergens["verified_at"] = previous.get("verified_at")
    product.allergens = allergens
    product.allergen_source = {"verified": "merchant_verified", "needs_review": "merchant_unverified", "missing": "missing"}[allergens["status"]]
    product.per_order_limit = data.per_order_limit
    product.surplus_priority = data.surplus_priority
    if data.relist is not None:
        product.relist_daily = data.relist.enabled
        product.relist_qty = data.relist.qty
        product.relist_cutoff_local = data.relist.cutoff_local


def _photo(db: Session, url: str | None, merchant_id: str, current: str | None) -> str | None:
    """A product photo is one this shop uploaded (or a bundled showcase photo). Left out on an edit, the current photo stays."""
    if url is None or url == current:
        return current
    asset = db.get(Asset, url.removeprefix(media.url("")))
    if asset is None or asset.merchant_id not in (merchant_id, None):
        raise Unprocessable("Upload a photo of this product", code="photo_invalid")
    return url


def update_product(user: StaffContext, product_id: str, data: ProductInput) -> dict[str, Any]:
    require_role(user, "manager")
    with transaction() as db:
        merchant = merchant_by_id(db, user.merchant_id)
        product = db.get(Product, product_id, with_for_update=True)
        if product is None or product.merchant_id != user.merchant_id:
            raise NotFound("Product not found")
        before = {"allergens": product.allergens, "name": product.name, "description": product.description}
        _apply_product(product, data, user)
        product.image_url = _photo(db, data.image_url, user.merchant_id, product.image_url)
        product.updated_at = clock.now()
        audit.record(db, actor=user.actor, actor_role=user.role, entity_type="product", entity_id=product.id, action="product_updated",
                     meta={"before": before, "after": {"allergens": product.allergens, "name": product.name, "description": product.description}})
        db.flush()
        return next(r for r in inventory_rows(db, merchant, clock.now()) if r["product_id"] == product.id)


class NewProduct(ProductInput):
    sku: str = Field(pattern=r"^[A-Z0-9][A-Z0-9-]{1,15}$")
    image_url: str = Field(max_length=500)  # shoppers only see products with a real photo
    surplus: int = Field(ge=0, le=500)
    reference_minor: int = Field(ge=1, le=100_000)
    sale_minor: int = Field(ge=1, le=100_000)
    reference_source: str = Field(min_length=4, max_length=200)
    cutoff_local: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")


def create_product(user: StaffContext, data: NewProduct) -> dict[str, Any]:
    require_role(user, "manager")
    if data.sale_minor > data.reference_minor:
        raise Unprocessable("Sale price can't exceed the reference price", code="invalid_price")
    with transaction() as db:
        merchant = merchant_by_id(db, user.merchant_id)
        if db.scalar(select(Product).where(Product.merchant_id == merchant.id, Product.sku == data.sku)):
            raise Conflict("That SKU already exists", code="duplicate_sku")
        now = clock.now()
        product = Product(id=new_id("prd"), merchant_id=merchant.id, sku=data.sku, status="active")
        _apply_product(product, data, user)
        product.image_url = _photo(db, data.image_url, merchant.id, None)
        db.add(product)
        db.flush()
        db.add(Price(id=new_id("prc"), product_id=product.id, sku=data.sku, currency=merchant.currency, reference_minor=data.reference_minor,
                     sale_minor=data.sale_minor, reference_source=data.reference_source, effective_at=now, created_by=user.actor))
        db.add(InventoryLot(id=new_id("lot"), product_id=product.id, on_hand=data.surplus, surplus_qty=data.surplus, buffer_qty=0,
                            cutoff_at=clock.combine_local(clock.local_date(merchant.timezone), data.cutoff_local, merchant.timezone),
                            updated_by=user.actor, updated_at=now))
        db.add(InventoryEvent(merchant_id=merchant.id, product_id=product.id, sku=data.sku, event_type="LISTED", delta=data.surplus,
                              surplus_before=0, surplus_after=data.surplus, actor=user.actor, reason="New product listed", created_at=now))
        jobs.enqueue("watches.scan", {"merchant_id": merchant.id}, delay_seconds=15, dedupe_key=f"watches.scan:{merchant.id}", db=db)
        audit.record(db, actor=user.actor, actor_role=user.role, entity_type="product", entity_id=product.id, action="product_created", meta={"sku": data.sku})
        db.flush()
        return next(r for r in inventory_rows(db, merchant, now) if r["product_id"] == product.id)


class PriceInput(BaseModel):
    reference_minor: int = Field(ge=1, le=100_000)
    sale_minor: int = Field(ge=1, le=100_000)
    reference_source: str = Field(min_length=4, max_length=200)


def set_price(user: StaffContext, product_id: str, data: PriceInput) -> dict[str, Any]:
    require_role(user, "manager")
    if data.sale_minor > data.reference_minor:
        raise Unprocessable("Sale price can't exceed the reference price (we never invent savings)", code="invalid_price")
    with transaction() as db:
        merchant = merchant_by_id(db, user.merchant_id)
        product = db.get(Product, product_id)
        if product is None or product.merchant_id != user.merchant_id:
            raise NotFound("Product not found")
        now = clock.now()
        old = current_prices(db, [product.id], now).get(product.id)
        db.add(Price(id=new_id("prc"), product_id=product.id, sku=product.sku, currency=merchant.currency, reference_minor=data.reference_minor,
                     sale_minor=data.sale_minor, reference_source=data.reference_source, effective_at=now, created_by=user.actor,
                     tax_category=old.tax_category if old else "bakery"))
        lot = lock_lots(db, [product.id])[product.id]
        lot.version += 1
        lot.updated_at = now
        db.add(InventoryEvent(merchant_id=merchant.id, product_id=product.id, sku=product.sku, event_type="PRICE_CHANGED", delta=0,
                              surplus_before=lot.surplus_qty, surplus_after=lot.surplus_qty, actor=user.actor,
                              reason=f"{format_money(old.sale_minor, merchant.currency) if old else '-'} -> {format_money(data.sale_minor, merchant.currency)}",
                              created_at=now))
        audit.record(db, actor=user.actor, actor_role=user.role, entity_type="product", entity_id=product.id, action="price_changed",
                     meta={"old": {"reference_minor": old.reference_minor, "sale_minor": old.sale_minor} if old else None, "new": data.model_dump()})
        db.flush()
        return next(r for r in inventory_rows(db, merchant, now) if r["product_id"] == product.id)


def product_history(user: StaffContext, product_id: str) -> dict[str, Any]:
    with transaction() as db:
        product = db.get(Product, product_id)
        if product is None or product.merchant_id != user.merchant_id:
            raise NotFound("Product not found")
        events = db.scalars(select(InventoryEvent).where(InventoryEvent.product_id == product_id).order_by(InventoryEvent.created_at.desc()).limit(80)).all()
        audits = db.scalars(select(AuditEvent).where(AuditEvent.entity_type == "product", AuditEvent.entity_id == product_id)
                            .order_by(AuditEvent.timestamp.desc()).limit(80)).all()
        return {
            "inventory_events": [
                {"at": clock.iso(e.created_at), "type": e.event_type, "delta": e.delta, "before": e.surplus_before, "after": e.surplus_after,
                 "actor": e.actor, "reason": e.reason, "reference_id": e.reference_id}
                for e in events
            ],
            "audit": [{"at": clock.iso(a.timestamp), "action": a.action, "actor": a.actor, "meta": a.meta} for a in audits],
        }



@jobs.handler("inventory.monitor", every=60)
def _monitor(_: dict[str, Any]) -> dict[str, int]:
    return monitor_inventory()


def monitor_inventory() -> dict[str, int]:
    """Alert on stale stock counts, low stock and items past their pickup cutoff."""
    raised = 0
    with transaction() as db:
        for merchant in list_merchants(db):
            raised += _monitor_merchant(db, merchant)
    return {"alerts": raised}


def _since(updated_iso: str, tz: str, now: datetime) -> str:
    """'9:45 AM' today, else 'Nov 6, 9:45 AM' (in the shop's timezone); never a raw timestamp."""
    at = datetime.fromisoformat(updated_iso.replace("Z", "+00:00"))
    label = clock.display_time(at, tz)
    if at.astimezone(ZoneInfo(tz)).date() == now.astimezone(ZoneInfo(tz)).date():
        return label
    return f"{at.astimezone(ZoneInfo(tz)).strftime('%b %-d')}, {label}"


def _monitor_merchant(db: Session, merchant: Merchant) -> int:
    raised = 0
    now = clock.now()
    low = int(policy(merchant, "low_stock_threshold", 2))
    for row in inventory_rows(db, merchant, now):
        if row["status"] != "active":
            continue
        if row["stale"]:
            raise_alert(db, merchant.id, "stale_inventory", "product", row["product_id"],
                        f"{row['name']}: stock count not updated since {_since(row['updated_at'], merchant.timezone, now)}. "
                        "Confirm it's still accurate.", "medium")
            raised += 1
        if 0 < row["available"] <= low:
            raise_alert(db, merchant.id, "low_stock", "product", row["product_id"], f"{row['name']}: only {row['available']} left", "low")
        else:
            resolve_alerts(db, merchant.id, "low_stock", row["product_id"])
        if row["availability_status"] == "past_cutoff" and row["surplus"] - row["committed"] > 0:
            raise_alert(db, merchant.id, "past_cutoff", "product", row["product_id"],
                        f"{row['name']}: pickup cutoff passed with unsold surplus; update or remove the listing", "low")
    return raised


# --------------------------------------------------------------------------- settings (M04)
