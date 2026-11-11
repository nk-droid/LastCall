"""CatalogService + InventoryService read side.

available_to_sell = surplus_qty - active_reservations - committed_unfulfilled - merchant_buffer

Active reservations are HELD holds that have not expired plus PAYMENT_IN_FLIGHT holds
(which never lapse on their own). Committed units are paid orders not yet handed off.
All of it is derived from reservation rows, so there are no counters to drift.

Only live shops are visible to shoppers; members can preview their own shop before it
goes live. Unpriced or unstocked products are never sellable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app import clock
from app.domain import source_label
from app.errors import NotFound
from app.models import InventoryLot, Membership, Merchant, Price, Product, Reservation, ReservationLine


def get_merchant(db: Session, slug: str, *, viewer_id: str | None = None) -> Merchant:
    """A shop by slug, as a shopper may see it: live shops, or any shop the viewer is a member of (preview)."""
    merchant = db.scalar(select(Merchant).where(Merchant.slug == slug))
    if merchant is None or not (merchant.is_live or (viewer_id and is_member(db, viewer_id, merchant.id))):
        raise NotFound("We couldn't find that shop", code="merchant_not_found")
    return merchant


def is_member(db: Session, user_id: str, merchant_id: str) -> bool:
    return db.scalar(select(Membership.id).where(Membership.user_id == user_id, Membership.merchant_id == merchant_id)) is not None


def merchant_by_id(db: Session, merchant_id: str) -> Merchant:
    """The merchant that owns a record (quote, order, staff user). Never falls back to a default."""
    merchant = db.get(Merchant, merchant_id)
    if merchant is None:
        raise NotFound("Merchant not found", code="merchant_not_found")
    return merchant


def list_merchants(db: Session) -> list[Merchant]:
    """Every live shop, by name."""
    return list(db.scalars(select(Merchant).where(Merchant.status == "live").order_by(Merchant.name)).all())


def address_line(merchant: Merchant) -> str:
    a = merchant.address or {}
    return ", ".join(x for x in [a.get("line1"), a.get("city"), a.get("region"), a.get("postal_code")] if x)


def merchant_ref(merchant: Merchant) -> dict[str, Any]:
    """The shop a quote or order belongs to, for headers, receipts and 'My orders'."""
    return {"id": merchant.id, "slug": merchant.slug, "name": merchant.name, "category": merchant.category, "timezone": merchant.timezone,
            "address": address_line(merchant), "phone": merchant.phone, "support_email": merchant.support_email}


def policy(merchant: Merchant, key: str, default: Any = None) -> Any:
    return (merchant.policies or {}).get(key, default)


def current_prices(db: Session, product_ids: list[str], at: datetime) -> dict[str, Price]:
    if not product_ids:
        return {}
    rows = db.scalars(
        select(Price)
        .where(Price.product_id.in_(product_ids), Price.effective_at <= at)
        .order_by(Price.product_id, Price.effective_at.desc(), Price.created_at.desc())
        .distinct(Price.product_id)
    ).all()
    return {p.product_id: p for p in rows}


def active_hold_condition(now: datetime):
    return or_(
        and_(Reservation.state == "HELD", Reservation.expires_at > now),
        Reservation.state == "PAYMENT_IN_FLIGHT",
    )


@dataclass
class Availability:
    surplus: int
    reserved: int
    committed: int
    buffer: int
    on_hand: int
    cutoff_at: datetime
    updated_at: datetime
    version: int

    @property
    def held(self) -> int:
        return self.reserved + self.committed

    @property
    def available(self) -> int:
        return max(0, self.surplus - self.reserved - self.committed - self.buffer)


def availability(
    db: Session,
    merchant_id: str,
    now: datetime,
    product_ids: list[str] | None = None,
    exclude_reservation_id: str | None = None,
) -> dict[str, Availability]:
    lot_query = select(InventoryLot, Product.id).join(Product, Product.id == InventoryLot.product_id).where(
        Product.merchant_id == merchant_id
    )
    if product_ids is not None:
        lot_query = lot_query.where(Product.id.in_(product_ids))
    lots = db.execute(lot_query).all()

    def sums(condition) -> dict[str, int]:
        query = (
            select(ReservationLine.product_id, func.coalesce(func.sum(ReservationLine.qty), 0))
            .join(Reservation, Reservation.id == ReservationLine.reservation_id)
            .where(Reservation.merchant_id == merchant_id, condition)
            .group_by(ReservationLine.product_id)
        )
        if product_ids is not None:
            query = query.where(ReservationLine.product_id.in_(product_ids))
        if exclude_reservation_id:
            query = query.where(Reservation.id != exclude_reservation_id)
        return {pid: int(total) for pid, total in db.execute(query).all()}

    reserved = sums(active_hold_condition(now))
    committed = sums(Reservation.state == "COMMITTED")
    result: dict[str, Availability] = {}
    for lot, product_id in lots:
        result[product_id] = Availability(
            surplus=lot.surplus_qty,
            reserved=reserved.get(product_id, 0),
            committed=committed.get(product_id, 0),
            buffer=lot.buffer_qty,
            on_hand=lot.on_hand,
            cutoff_at=lot.cutoff_at,
            updated_at=lot.updated_at,
            version=lot.version,
        )
    return result


@dataclass(frozen=True)
class CatalogItem:
    """Immutable snapshot of one product as the bundle engine and quotes see it."""

    product_id: str
    sku: str
    name: str
    description: str
    category: str
    flavor: str
    servings: float
    tags: tuple[str, ...]
    sale_minor: int
    reference_minor: int
    currency: str
    tax_category: str
    reference_source: str
    available: int
    per_order_limit: int
    surplus_priority: int
    cutoff_at: datetime
    updated_at: datetime
    status: str
    allergens: dict[str, Any] = field(hash=False, compare=False)
    allergen_source: str = ""
    attributes: dict[str, Any] = field(default_factory=dict, hash=False, compare=False)
    image_url: str | None = None
    price_id: str = ""

    @property
    def sellable(self) -> bool:
        return self.status == "active" and self.available > 0


def availability_status(item: CatalogItem, now: datetime, low_threshold: int) -> str:
    if item.status != "active":
        return "paused"
    if item.cutoff_at <= now:
        return "past_cutoff"
    if item.available <= 0:
        return "sold_out"
    if item.available <= low_threshold:
        return "low"
    return "available"


def catalog_items(
    db: Session,
    merchant: Merchant,
    now: datetime | None = None,
    *,
    exclude_reservation_id: str | None = None,
    include_archived: bool = False,
    include_without_photo: bool = False,
) -> list[CatalogItem]:
    """Products as shoppers see them. A product without a photo isn't shown to shoppers until it has one."""
    now = now or clock.now()
    query = select(Product).where(Product.merchant_id == merchant.id)
    if not include_archived:
        query = query.where(Product.status != "archived")
    if not include_without_photo:
        query = query.where(Product.image_url.is_not(None))
    products = db.scalars(query.order_by(Product.sku)).all()
    ids = [p.id for p in products]
    prices = current_prices(db, ids, now)
    avail = availability(db, merchant.id, now, ids, exclude_reservation_id=exclude_reservation_id)
    items: list[CatalogItem] = []
    for p in products:
        price = prices.get(p.id)
        a = avail.get(p.id)
        if price is None or a is None:
            continue  # unpriced or unstocked products are never sellable
        attrs = p.attributes or {}
        items.append(
            CatalogItem(
                product_id=p.id,
                sku=p.sku,
                name=p.name,
                description=p.description,
                category=p.category,
                flavor=attrs.get("flavor", "sweet"),
                servings=float(attrs.get("servings_per_unit", 1)),
                tags=tuple(attrs.get("tags", [])),
                sale_minor=price.sale_minor,
                reference_minor=price.reference_minor,
                currency=price.currency,
                tax_category=price.tax_category,
                reference_source=price.reference_source,
                available=a.available if a.cutoff_at > now else 0,
                per_order_limit=p.per_order_limit,
                surplus_priority=p.surplus_priority,
                cutoff_at=a.cutoff_at,
                updated_at=a.updated_at,
                status=p.status,
                allergens=p.allergens or {},
                allergen_source=p.allergen_source,
                attributes=attrs,
                image_url=p.image_url,
                price_id=price.id,
            )
        )
    return items


def image_view(item_or_product: Any) -> dict[str, Any]:
    url = getattr(item_or_product, "image_url", None)
    name = item_or_product.name
    return {"url": url, "alt": f"Photo of {name}" if url else f"{name} (no photo yet)"}


def allergen_view(allergens: dict[str, Any], allergen_source: str) -> dict[str, Any]:
    return {
        "contains": list(allergens.get("contains", [])),
        "cross_contact": list(allergens.get("cross_contact", [])),
        "status": allergens.get("status", "missing"),
        "source": allergen_source,
        "source_label": source_label(allergens),
        "verified_by": allergens.get("verified_by"),
        "verified_at": allergens.get("verified_at"),
        "notes": allergens.get("notes", ""),
    }


def item_view(item: CatalogItem, merchant: Merchant, now: datetime) -> dict[str, Any]:
    low = int(policy(merchant, "low_stock_threshold", 2))
    discount = item.reference_minor - item.sale_minor
    return {
        "product_id": item.product_id,
        "sku": item.sku,
        "name": item.name,
        "description": item.description,
        "category": item.category,
        "flavor": item.flavor,
        "servings_per_unit": item.servings,
        "tags": list(item.tags),
        "image": image_view(item),
        "price": {
            "currency": item.currency,
            "reference_minor": item.reference_minor,
            "sale_minor": item.sale_minor,
            "discount_minor": discount,
            "discount_pct": round(100 * discount / item.reference_minor) if item.reference_minor else 0,
            "reference_source": item.reference_source,
        },
        "availability": {
            "available": item.available,
            "status": availability_status(item, now, low),
            "cutoff_at": clock.iso(item.cutoff_at),
            "cutoff_label": clock.display_time(item.cutoff_at, merchant.timezone),
            "updated_at": clock.iso(item.updated_at),
            "per_order_limit": item.per_order_limit,
        },
        "allergens": allergen_view(item.allergens, item.allergen_source),
        "dietary": (item.attributes or {}).get("dietary", {}),
        "ingredients": (item.attributes or {}).get("ingredients", ""),
    }


def lock_lots(db: Session, product_ids: list[str]) -> dict[str, InventoryLot]:
    """Row-lock inventory lots in a fixed order (sorted product ids) so concurrent writers never deadlock."""
    lots = db.scalars(
        select(InventoryLot).where(InventoryLot.product_id.in_(sorted(set(product_ids)))).order_by(InventoryLot.product_id).with_for_update()
    ).all()
    return {lot.product_id: lot for lot in lots}
