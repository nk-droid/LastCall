"""Orders and money: orders (payment and fulfillment are separate fields), PayPal payment attempts,
refunds, verified webhook events, support requests and operator fault injection."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_col, updated_col


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    order_number: Mapped[str] = mapped_column(String(20), unique=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"), index=True)
    quote_id: Mapped[str] = mapped_column(ForeignKey("bundle_quotes.id"), unique=True)
    reservation_id: Mapped[str] = mapped_column(ForeignKey("reservations.id"))
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    # The signed-in shopper who placed (or later claimed) the order; guests are identified by session only.
    customer_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    customer_contact: Mapped[dict[str, Any]] = mapped_column(JSONB)
    # QUOTED RESERVED APPROVAL_PENDING APPROVED CAPTURE_REQUESTED CAPTURE_PENDING
    # CAPTURED CAPTURE_FAILED OUTCOME_UNKNOWN EXPIRED
    payment_status: Mapped[str] = mapped_column(String(24), index=True)
    # NEW PACKING READY PICKED_UP CANCELLED
    fulfillment_status: Mapped[str] = mapped_column(String(16), index=True)
    # NONE REQUESTED PENDING COMPLETED FAILED
    refund_status: Mapped[str] = mapped_column(String(16), default="NONE")
    amount_minor: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3))
    pickup_slot_id: Mapped[str] = mapped_column(ForeignKey("pickup_slots.id"))
    pickup_starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    pickup_ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    pickup_code_hash: Mapped[str] = mapped_column(String(64))
    pickup_code_salt: Mapped[str] = mapped_column(String(40))
    pickup_attempts: Mapped[int] = mapped_column(Integer, default=0)
    access_token_hash: Mapped[str] = mapped_column(String(64))
    cancel_request: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    packed_skus: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    exception_flags: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    picked_up_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    pickup_expired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    contact_purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trace_id: Mapped[str] = mapped_column(String(40))
    created_at: Mapped[datetime] = created_col()
    updated_at: Mapped[datetime] = updated_col()


class PaymentAttempt(Base):
    __tablename__ = "payment_attempts"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    quote_id: Mapped[str] = mapped_column(ForeignKey("bundle_quotes.id"))
    provider: Mapped[str] = mapped_column(String(20), default="paypal")
    environment: Mapped[str] = mapped_column(String(20))
    paypal_order_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    capture_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    request_id: Mapped[str] = mapped_column(String(64), unique=True)
    # The shop's PayPal account this attempt pays ({"merchant_id"} or {"email"}); null pays the platform account.
    payee: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    capture_request_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    # CREATING APPROVAL_PENDING APPROVED CAPTURE_REQUESTED CAPTURE_PENDING CAPTURED
    # CAPTURE_FAILED OUTCOME_UNKNOWN EXPIRED VOIDED
    state: Mapped[str] = mapped_column(String(24), index=True)
    provider_state: Mapped[str | None] = mapped_column(String(40), nullable=True)
    amount_minor: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3))
    captured_amount_minor: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_error: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    provider_debug_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    create_response: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    capture_response: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    reconcile_count: Mapped[int] = mapped_column(Integer, default=0)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    capture_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = created_col()
    updated_at: Mapped[datetime] = updated_col()


class Refund(Base):
    __tablename__ = "refunds"
    __table_args__ = (CheckConstraint("amount_minor > 0", name="ck_refund_amount_positive"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    payment_attempt_id: Mapped[str] = mapped_column(ForeignKey("payment_attempts.id"), index=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    amount_minor: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3))
    paypal_refund_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    request_id: Mapped[str] = mapped_column(String(64), unique=True)
    # REQUESTED PENDING COMPLETED FAILED OUTCOME_UNKNOWN
    state: Mapped[str] = mapped_column(String(20))
    provider_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    requested_by: Mapped[str] = mapped_column(String(80))
    return_to_stock: Mapped[bool] = mapped_column(Boolean, default=True)
    last_error: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = created_col()
    updated_at: Mapped[datetime] = updated_col()
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WebhookEvent(Base):
    __tablename__ = "webhook_events"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    provider_event_id: Mapped[str] = mapped_column(String(120), unique=True)
    event_type: Mapped[str] = mapped_column(String(80))
    resource_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    resource_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    verification: Mapped[str] = mapped_column(String(30))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    raw_body: Mapped[str] = mapped_column(Text)
    transmission: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    duplicate_count: Mapped[int] = mapped_column(Integer, default=0)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    processing_result: Mapped[str | None] = mapped_column(Text, nullable=True)
    received_at: Mapped[datetime] = created_col()


class SupportRequest(Base):
    __tablename__ = "support_requests"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    topic: Mapped[str] = mapped_column(String(40), default="general")
    message: Mapped[str] = mapped_column(Text)
    ai_draft: Mapped[str] = mapped_column(Text, default="")
    ai_draft_source: Mapped[str] = mapped_column(String(20), default="rules")
    ai_invocation_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="open")
    staff_reply: Mapped[str | None] = mapped_column(Text, nullable=True)
    replied_by: Mapped[str | None] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = created_col()
    replied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FaultInjection(Base):
    """Operator-controlled failure injection for demonstrating recovery paths."""

    __tablename__ = "fault_injections"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    remaining: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = created_col()
