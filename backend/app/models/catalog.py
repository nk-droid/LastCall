"""Catalog and stock: products, today's surplus lots, price history, pickup slots, inventory
events, merchant alerts and product analytics events."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_col, updated_col

PRODUCT_CATEGORIES = ("pastry", "bread", "cookie", "cake", "savory")


class Product(Base):
    __tablename__ = "products"
    __table_args__ = (UniqueConstraint("merchant_id", "sku", name="uq_products_merchant_sku"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"), index=True)
    sku: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    description_source: Mapped[str] = mapped_column(String(30), default="merchant")
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    category: Mapped[str] = mapped_column(String(30))
    # flavor, servings_per_unit, tags, dietary {vegetarian, vegan}, ingredients
    attributes: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    # contains[], cross_contact[], status verified|needs_review|missing, verified_by, verified_at, notes
    allergens: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    allergen_source: Mapped[str] = mapped_column(String(40), default="missing")
    # active | paused | archived
    status: Mapped[str] = mapped_column(String(20), default="active")
    per_order_limit: Mapped[int] = mapped_column(Integer, default=6)
    surplus_priority: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = created_col()
    updated_at: Mapped[datetime] = updated_col()


class InventoryLot(Base):
    """Today's surplus listing for one product (one lot per product, re-listed each day)."""

    __tablename__ = "inventory_lots"
    __table_args__ = (
        CheckConstraint("surplus_qty >= 0", name="ck_lot_surplus_nonneg"),
        CheckConstraint("buffer_qty >= 0", name="ck_lot_buffer_nonneg"),
        CheckConstraint("on_hand >= 0", name="ck_lot_on_hand_nonneg"),
    )

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"), unique=True)
    on_hand: Mapped[int] = mapped_column(Integer, default=0)
    surplus_qty: Mapped[int] = mapped_column(Integer)
    buffer_qty: Mapped[int] = mapped_column(Integer, default=0)
    cutoff_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_by: Mapped[str] = mapped_column(String(80), default="system")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Price(Base):
    """Append-only price history; the newest effective row is current."""

    __tablename__ = "prices"
    __table_args__ = (
        CheckConstraint("sale_minor > 0", name="ck_price_sale_positive"),
        CheckConstraint("reference_minor >= sale_minor", name="ck_price_reference_gte_sale"),
        Index("ix_prices_product_effective", "product_id", "effective_at"),
    )

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"))
    sku: Mapped[str] = mapped_column(String(32))
    currency: Mapped[str] = mapped_column(String(3))
    reference_minor: Mapped[int] = mapped_column(Integer)
    sale_minor: Mapped[int] = mapped_column(Integer)
    tax_category: Mapped[str] = mapped_column(String(40), default="bakery")
    reference_source: Mapped[str] = mapped_column(Text, default="")
    effective_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(String(80), default="system")
    created_at: Mapped[datetime] = created_col()


class PickupSlot(Base):
    __tablename__ = "pickup_slots"
    __table_args__ = (
        UniqueConstraint("merchant_id", "starts_at", name="uq_slot_merchant_start"),
        CheckConstraint("booked_count >= 0", name="ck_slot_booked_nonneg"),
        CheckConstraint("capacity >= 0", name="ck_slot_capacity_nonneg"),
    )

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"), index=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    capacity: Mapped[int] = mapped_column(Integer)
    booked_count: Mapped[int] = mapped_column(Integer, default=0)
    # open | closed
    status: Mapped[str] = mapped_column(String(20), default="open")


class InventoryEvent(Base):
    __tablename__ = "inventory_events"
    __table_args__ = (Index("ix_inventory_events_product_time", "product_id", "created_at"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"))
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"))
    sku: Mapped[str] = mapped_column(String(32))
    # LISTED ADJUSTED COUNTER_SALE BUFFER_CHANGED CUTOFF_CHANGED ON_HAND_CHANGED PRICE_CHANGED PAUSED RESUMED
    # FULFILLED WRITE_OFF RELISTED
    event_type: Mapped[str] = mapped_column(String(30))
    delta: Mapped[int] = mapped_column(Integer, default=0)
    surplus_before: Mapped[int] = mapped_column(Integer)
    surplus_after: Mapped[int] = mapped_column(Integer)
    actor: Mapped[str] = mapped_column(String(80))
    reason: Mapped[str] = mapped_column(Text, default="")
    reference_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class MerchantAlert(Base):
    __tablename__ = "merchant_alerts"
    __table_args__ = (
        Index("uq_open_alert", "merchant_id", "kind", "entity_id", unique=True, postgresql_where=text("resolved_at IS NULL")),
    )

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"))
    kind: Mapped[str] = mapped_column(String(40))
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str] = mapped_column(String(64))
    severity: Mapped[str] = mapped_column(String(12))
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = created_col()
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AnalyticsEvent(Base):
    __tablename__ = "analytics_events"
    __table_args__ = (Index("ix_analytics_merchant_name_time", "merchant_id", "event_name", "created_at"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    merchant_id: Mapped[str] = mapped_column(String(40))
    event_name: Mapped[str] = mapped_column(String(40))
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    entity_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    entity_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    properties: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
