"""Merchant alerts: at most one open alert per (shop, kind, entity); resolved, never deleted."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.errors import NotFound
from app.ids import new_id
from app.models import MerchantAlert
from app.services import audit
from app.services.access import StaffContext

SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2}


def raise_alert(db: Session, merchant_id: str, kind: str, entity_type: str, entity_id: str, message: str, severity: str = "medium") -> None:
    db.execute(
        insert(MerchantAlert)
        .values(id=new_id("alr"), merchant_id=merchant_id, kind=kind, entity_type=entity_type, entity_id=entity_id, severity=severity, message=message)
        .on_conflict_do_nothing()
    )


def resolve_alerts(db: Session, merchant_id: str, kind: str, entity_id: str) -> None:
    for alert in db.scalars(select(MerchantAlert).where(MerchantAlert.merchant_id == merchant_id, MerchantAlert.kind == kind,
                                                        MerchantAlert.entity_id == entity_id, MerchantAlert.resolved_at.is_(None))).all():
        alert.resolved_at = clock.now()


def resolve_by_id(ctx: StaffContext, alert_id: str) -> None:
    with transaction() as db:
        alert = db.get(MerchantAlert, alert_id, with_for_update=True)
        if alert is None or alert.merchant_id != ctx.merchant_id:
            raise NotFound("Alert not found")
        alert.resolved_at = clock.now()
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="alert", entity_id=alert.id, action="alert_resolved", meta={"kind": alert.kind})


def open_alerts(db: Session, merchant_id: str) -> list[dict[str, Any]]:
    rows = db.scalars(select(MerchantAlert).where(MerchantAlert.merchant_id == merchant_id, MerchantAlert.resolved_at.is_(None))).all()
    return [
        {"id": a.id, "kind": a.kind, "severity": a.severity, "message": a.message, "entity_type": a.entity_type, "entity_id": a.entity_id,
         "created_at": clock.iso(a.created_at)}
        for a in sorted(rows, key=lambda a: (SEVERITY_RANK.get(a.severity, 3), a.created_at))
    ]
