"""AuditService: immutable records for every consequential action (payments, stock, fulfillment)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditEvent
from app.observability import correlation_id_var, redact_obj, trace_id_var


def record(
    db: Session,
    *,
    actor: str,
    actor_role: str,
    entity_type: str,
    entity_id: str,
    action: str,
    meta: dict[str, Any] | None = None,
    trace_id: str | None = None,
) -> None:
    db.add(
        AuditEvent(
            actor=actor,
            actor_role=actor_role,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            meta=redact_obj(meta or {}),
            correlation_id=correlation_id_var.get(),
            trace_id=trace_id or trace_id_var.get(),
        )
    )


def customer_actor(session_id: str) -> str:
    return f"customer:{session_id[:10]}"
