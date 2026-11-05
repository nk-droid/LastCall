"""Operator-controlled failure injection, used to demonstrate (and test) recovery paths.

* capture_response_lost  - the capture really happens at PayPal, then the response is dropped
* capture_timeout        - the capture request never reaches PayPal (timeout before send)
* capture_declined       - INSTRUMENT_DECLINED (PayPal-Mock-Response negative testing in the Sandbox)
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.db import transaction
from app.ids import new_id
from app.models import FaultInjection
from app.payments.base import PayPalClient, PayPalOutcomeUnknown

FAULT_KINDS = {
    "capture_response_lost": "Capture succeeds at PayPal but the response is lost",
    "capture_timeout": "Capture request times out before reaching PayPal",
    "capture_declined": "Buyer's funding instrument is declined at capture",
}


def arm(kind: str, actor: str, count: int = 1) -> dict[str, Any]:
    if kind not in FAULT_KINDS:
        raise ValueError(f"unknown fault {kind}")
    with transaction() as db:
        row = FaultInjection(id=new_id("flt"), kind=kind, remaining=count, created_by=actor)
        db.add(row)
        return {"id": row.id, "kind": kind, "remaining": count}


def consume(kind: str) -> bool:
    with transaction() as db:
        row = db.scalar(
            select(FaultInjection)
            .where(FaultInjection.kind == kind, FaultInjection.remaining > 0)
            .order_by(FaultInjection.created_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        if row is None:
            return False
        row.remaining -= 1
        return True


def armed() -> list[dict[str, Any]]:
    with transaction() as db:
        rows = db.scalars(select(FaultInjection).where(FaultInjection.remaining > 0).order_by(FaultInjection.created_at)).all()
        return [{"id": r.id, "kind": r.kind, "remaining": r.remaining, "description": FAULT_KINDS[r.kind]} for r in rows]


def disarm_all() -> None:
    with transaction() as db:
        for row in db.scalars(select(FaultInjection).where(FaultInjection.remaining > 0)).all():
            row.remaining = 0


class FaultInjectingClient:
    """Wraps the Sandbox client; behaviour is unchanged unless a fault is armed."""

    def __init__(self, inner: PayPalClient):
        self.inner = inner
        self.environment = inner.environment

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)

    def capture_order(self, order_id: str, request_id: str) -> dict[str, Any]:
        if consume("capture_timeout"):
            raise PayPalOutcomeUnknown("capture", "injected timeout before reaching PayPal")
        if consume("capture_declined"):
            self.inner.mock_next_capture = "INSTRUMENT_DECLINED"
        lose_response = consume("capture_response_lost")
        result = self.inner.capture_order(order_id, request_id)
        if lose_response:
            raise PayPalOutcomeUnknown("capture", "injected: capture succeeded but the response was lost")
        return result
