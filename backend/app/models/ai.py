"""Model call log: one row per AI invocation (prompt version, model, validity, latency, tokens). Inputs are hashed, never stored."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_col


class AIInvocation(Base):
    __tablename__ = "ai_invocations"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    task: Mapped[str] = mapped_column(String(40), index=True)
    prompt_version: Mapped[str] = mapped_column(String(40))
    provider: Mapped[str] = mapped_column(String(30))
    model: Mapped[str] = mapped_column(String(80))
    input_hash: Mapped[str] = mapped_column(String(64))
    # valid | invalid_schema | rejected | error | timeout | skipped
    validation_result: Mapped[str] = mapped_column(String(30))
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    repaired: Mapped[bool] = mapped_column(Boolean, default=False)
    fallback_used: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = created_col()
