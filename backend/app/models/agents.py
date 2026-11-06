"""Agent runs: one row per tool-calling run and one per step, so every agent's reasoning is auditable.

A step stores the tool name, its (redacted) arguments and a truncated result. Model turns are also
logged as AIInvocation rows that point back to their run.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_col, updated_col


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)  # e.g. "concierge", "watch_match"
    prompt_version: Mapped[str] = mapped_column(String(60))
    model: Mapped[str] = mapped_column(String(80))
    # running | done | fallback | step_limit | timeout | error
    status: Mapped[str] = mapped_column(String(20), default="running")
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    user_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    subject_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    subject_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    steps: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = created_col()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AgentStep(Base):
    __tablename__ = "agent_steps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id", ondelete="CASCADE"), index=True)
    idx: Mapped[int] = mapped_column(Integer)
    # tool | final | message | error
    kind: Mapped[str] = mapped_column(String(20))
    tool: Mapped[str | None] = mapped_column(String(60), nullable=True)
    args: Mapped[dict[str, Any]] = mapped_column(default=dict)
    result: Mapped[dict[str, Any]] = mapped_column(default=dict)
    ok: Mapped[bool] = mapped_column(Boolean, default=True)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = created_col()


class Conversation(Base):
    """A shopper's chat with an agent (the concierge). Messages are stored redacted; each turn is one AgentRun."""

    __tablename__ = "agent_conversations"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), default="concierge")
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    user_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # Set when the chat is opened on one shop's storefront; the agent then only looks at that shop.
    scope_merchant_id: Mapped[str | None] = mapped_column(ForeignKey("merchants.id"), nullable=True)
    messages: Mapped[list[Any]] = mapped_column(default=list)
    status: Mapped[str] = mapped_column(String(20), default="idle")  # idle | working
    progress: Mapped[list[Any]] = mapped_column(default=list)  # what the agent is doing this turn, for the UI
    last_run_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = created_col()
    updated_at: Mapped[datetime] = updated_col()


class AgentProposal(Base):
    """Changes an agent suggests and a person approves (e.g. the close-out plan). Nothing here is applied until someone
    with the right role applies it; each action keeps its own status, and actions code rejected are kept as "dropped"."""

    __tablename__ = "agent_proposals"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)  # closeout
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"), index=True)
    run_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    subject_date: Mapped[str] = mapped_column(String(10))  # the shop's local date the plan is for
    # pending | partly_applied | applied | dismissed | expired | superseded
    status: Mapped[str] = mapped_column(String(20), default="pending")
    source: Mapped[str] = mapped_column(String(20), default="agent")  # agent | rules
    summary: Mapped[str] = mapped_column(Text, default="")
    actions: Mapped[list[Any]] = mapped_column(default=list)
    created_by: Mapped[str] = mapped_column(String(120))
    decided_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_col()
    updated_at: Mapped[datetime] = updated_col()
