"""Watches: a signed-in shopper's standing request ("croissant box under $10 after 4"), checked whenever shops list surplus.

A match is one bundle the shopper was emailed about; the same bundle is never sent twice for a watch.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_col, updated_col


class Watch(Base):
    __tablename__ = "watches"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # None means any live shop.
    merchant_id: Mapped[str | None] = mapped_column(ForeignKey("merchants.id"), nullable=True)
    text_redacted: Mapped[str] = mapped_column(Text, default="")
    # Structured request (the L1 Intent fields the shopper stated); applied fresh to each shop's day.
    constraints: Mapped[dict[str, Any]] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)  # active | paused | stopped | expired
    stop_token: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_scanned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = created_col()
    updated_at: Mapped[datetime] = updated_col()


class WatchMatch(Base):
    __tablename__ = "watch_matches"
    __table_args__ = (UniqueConstraint("watch_id", "merchant_id", "signature", name="uq_watch_match_bundle"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    watch_id: Mapped[str] = mapped_column(ForeignKey("watches.id", ondelete="CASCADE"), index=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"))
    signature: Mapped[str] = mapped_column(String(300))  # sorted "sku:qty" pairs
    label: Mapped[str] = mapped_column(String(80), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    summary_source: Mapped[str] = mapped_column(String(20), default="rules")  # agent | rules
    total_minor: Mapped[int] = mapped_column(Integer, default=0)
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    pickup_label: Mapped[str] = mapped_column(String(80), default="")
    agent_run_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    email_message_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The shopper's alerts inbox: when they saw it there, and whether they said "not this".
    seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    quote_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = created_col()
