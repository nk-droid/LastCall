"""The shopping flow: parsed intents, bundle proposals, immutable quotes, stock holds and substitution offers."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_col, updated_col


class CustomerIntent(Base):
    __tablename__ = "customer_intents"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"))
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    raw_text_redacted: Mapped[str] = mapped_column(Text, default="")
    structured_constraints: Mapped[dict[str, Any]] = mapped_column(JSONB)
    field_sources: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    clarifications: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    warnings: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    parser: Mapped[str] = mapped_column(String(20))
    prompt_version: Mapped[str] = mapped_column(String(40))
    ai_invocation_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = created_col()


class BundleProposal(Base):
    __tablename__ = "bundle_proposals"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"))
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    intent_id: Mapped[str] = mapped_column(ForeignKey("customer_intents.id"))
    options: Mapped[list[Any]] = mapped_column(JSONB)
    no_match: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    excluded: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    engine_version: Mapped[str] = mapped_column(String(40))
    ai_invocation_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    inventory_as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_col()


class BundleQuote(Base):
    """Immutable price snapshot. A changed basket is a new quote version in the same lineage."""

    __tablename__ = "bundle_quotes"
    __table_args__ = (
        UniqueConstraint("lineage_id", "quote_version", name="uq_quote_lineage_version"),
        CheckConstraint("amount_minor > 0", name="ck_quote_amount_positive"),
    )

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    lineage_id: Mapped[str] = mapped_column(String(40), index=True)
    quote_version: Mapped[int] = mapped_column(Integer)
    supersedes_quote_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"))
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    intent_id: Mapped[str | None] = mapped_column(ForeignKey("customer_intents.id"), nullable=True)
    proposal_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    option_id: Mapped[str | None] = mapped_column(String(60), nullable=True)
    source: Mapped[str] = mapped_column(String(20), default="bundle")
    item_lines: Mapped[list[Any]] = mapped_column(JSONB)
    currency: Mapped[str] = mapped_column(String(3))
    subtotal_reference_minor: Mapped[int] = mapped_column(Integer)
    discount_minor: Mapped[int] = mapped_column(Integer)
    subtotal_minor: Mapped[int] = mapped_column(Integer)
    tax_minor: Mapped[int] = mapped_column(Integer)
    fees_minor: Mapped[int] = mapped_column(Integer)
    amount_minor: Mapped[int] = mapped_column(Integer)
    pickup_slot_id: Mapped[str] = mapped_column(ForeignKey("pickup_slots.id"))
    pickup_slot_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB)
    eligibility_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB)
    # PROPOSED (awaiting customer acceptance) | ACTIVE | INVALIDATED | SUPERSEDED | EXPIRED | CONVERTED
    status: Mapped[str] = mapped_column(String(20), index=True)
    invalid_reason: Mapped[list[Any] | None] = mapped_column(JSONB, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trace_id: Mapped[str] = mapped_column(String(40))
    created_at: Mapped[datetime] = created_col()


class Reservation(Base):
    """Inventory hold. HELD expires on its own; PAYMENT_IN_FLIGHT needs reconciliation first."""

    __tablename__ = "reservations"
    __table_args__ = (Index("ix_reservations_state_expiry", "state", "expires_at"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    quote_id: Mapped[str] = mapped_column(ForeignKey("bundle_quotes.id"), unique=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"))
    session_id: Mapped[str] = mapped_column(String(64))
    pickup_slot_id: Mapped[str] = mapped_column(ForeignKey("pickup_slots.id"))
    sku_qty: Mapped[dict[str, Any]] = mapped_column(JSONB)
    # HELD | PAYMENT_IN_FLIGHT | COMMITTED | FULFILLED | RELEASED
    state: Mapped[str] = mapped_column(String(24))
    slot_booked: Mapped[bool] = mapped_column(Boolean, default=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    released_reason: Mapped[str | None] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = created_col()
    updated_at: Mapped[datetime] = updated_col()
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    fulfilled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ReservationLine(Base):
    __tablename__ = "reservation_lines"
    __table_args__ = (
        CheckConstraint("qty > 0", name="ck_reservation_line_qty_positive"),
        UniqueConstraint("reservation_id", "product_id", name="uq_reservation_line_product"),
    )

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    reservation_id: Mapped[str] = mapped_column(ForeignKey("reservations.id"), index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"), index=True)
    sku: Mapped[str] = mapped_column(String(32))
    qty: Mapped[int] = mapped_column(Integer)


class SubstitutionOffer(Base):
    __tablename__ = "substitution_offers"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    original_quote_id: Mapped[str] = mapped_column(ForeignKey("bundle_quotes.id"), index=True)
    proposed_quote_id: Mapped[str | None] = mapped_column(ForeignKey("bundle_quotes.id"), nullable=True)
    session_id: Mapped[str] = mapped_column(String(64))
    trigger: Mapped[str] = mapped_column(String(30))
    reasons: Mapped[list[Any]] = mapped_column(JSONB)
    comparison: Mapped[dict[str, Any]] = mapped_column(JSONB)
    alternatives: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    explanation: Mapped[str] = mapped_column(Text, default="")
    explanation_source: Mapped[str] = mapped_column(String(20), default="rules")
    ai_invocation_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # OFFERED ACCEPTED REJECTED EXPIRED
    state: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = created_col()
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
