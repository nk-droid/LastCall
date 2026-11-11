"""LastCall's revenue: a commission on each paid order, billed to the shop weekly by PayPal invoice."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_col, updated_col


class PlatformFee(Base):
    """The commission on one paid order. ``fee_minor`` follows refunds; ``billed_minor`` is what invoices have charged so far,
    so a refund after billing becomes a credit on the next invoice."""

    __tablename__ = "platform_fees"
    __table_args__ = (CheckConstraint("fee_minor >= 0 AND billed_minor >= 0 AND basis_minor >= 0", name="ck_platform_fee_amounts"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"), index=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), unique=True)
    currency: Mapped[str] = mapped_column(String(3))
    basis_minor: Mapped[int] = mapped_column(Integer)  # the order's items at their surplus price, less refunds
    rate_bps: Mapped[int] = mapped_column(Integer)  # the terms when the order was paid
    min_minor: Mapped[int] = mapped_column(Integer)
    fee_minor: Mapped[int] = mapped_column(Integer)
    billed_minor: Mapped[int] = mapped_column(Integer, default=0)
    invoice_id: Mapped[str | None] = mapped_column(ForeignKey("fee_invoices.id"), nullable=True, index=True)
    accrued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_col()
    updated_at: Mapped[datetime] = updated_col()


class FeeInvoice(Base):
    """A PayPal invoice from LastCall to a shop for its fees up to ``period_end``."""

    __tablename__ = "fee_invoices"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"), index=True)
    number: Mapped[str] = mapped_column(String(40), unique=True)
    paypal_invoice_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    status: Mapped[str] = mapped_column(String(24))  # CREATING SENT PAID MARKED_AS_PAID CANCELLED FAILED (PayPal's words where it has them)
    currency: Mapped[str] = mapped_column(String(3))
    charges_minor: Mapped[int] = mapped_column(Integer)
    credit_minor: Mapped[int] = mapped_column(Integer, default=0)
    amount_minor: Mapped[int] = mapped_column(Integer)
    orders: Mapped[int] = mapped_column(Integer)
    # What this invoice charged or credited: [{"fee_id", "order_number", "delta_minor", "basis_minor", "accrued_at"}]
    lines: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    recipient_email: Mapped[str] = mapped_column(String(320))
    payer_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    request_id: Mapped[str] = mapped_column(String(64), unique=True)
    last_error: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = created_col()
    updated_at: Mapped[datetime] = updated_col()
