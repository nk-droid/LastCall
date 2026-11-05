"""Shops (tenants). Every catalog, order and staff membership belongs to exactly one merchant."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_col, updated_col

# draft -> pending_review -> live; a live shop can be suspended, a reviewed one rejected (back to draft on edit).
MERCHANT_STATUSES = ("draft", "pending_review", "live", "suspended", "rejected")


class Merchant(Base):
    __tablename__ = "merchants"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    tagline: Mapped[str] = mapped_column(String(200), default="")
    category: Mapped[str] = mapped_column(String(40), default="Bakery")
    description: Mapped[str] = mapped_column(Text, default="")
    address: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    phone: Mapped[str] = mapped_column(String(40), default="")
    support_email: Mapped[str] = mapped_column(String(160), default="")
    timezone: Mapped[str] = mapped_column(String(64))
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    hours: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    pickup_config: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    policies: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    policy_version: Mapped[int] = mapped_column(Integer, default=1)
    # Where this shop's PayPal payments are paid to: {"merchant_id", "email", "status", "verified_at"}.
    paypal: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    verification: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    pickup_paused: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    # Curated shops the platform seeds and keeps stocked; listed like any other live shop.
    is_showcase: Mapped[bool] = mapped_column(Boolean, default=False)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = created_col()
    updated_at: Mapped[datetime] = updated_col()

    @property
    def is_live(self) -> bool:
        return self.status == "live"
