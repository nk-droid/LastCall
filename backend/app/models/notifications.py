"""Outbound email outbox. Messages are written in the same transaction as the change that
caused them and delivered later by the worker, so a mail outage never blocks a request."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_col


class EmailMessage(Base):
    __tablename__ = "email_outbox"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    to_email: Mapped[str] = mapped_column(String(254))
    template: Mapped[str] = mapped_column(String(40), index=True)
    subject: Mapped[str] = mapped_column(String(200))
    text_body: Mapped[str] = mapped_column(Text)
    html_body: Mapped[str] = mapped_column(Text, default="")
    # Links in the body carry secrets; the context keeps only non-secret fields for display.
    context: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    # queued -> sent | failed | skipped (no transport configured)
    status: Mapped[str] = mapped_column(String(12), default="queued", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = created_col()
