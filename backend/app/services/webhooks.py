"""PayPal webhooks: verify authenticity, deduplicate by event ID, then reconcile against provider state.

The payload is only a hint about *which* resource changed; every state transition comes from
re-reading the order/capture/refund from PayPal and applying idempotent updates.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app import clock
from app.db import transaction
from app.errors import AppError
from app.ids import new_id
from app.models import Order, PaymentAttempt, Refund, WebhookEvent
from app.observability import metrics
from app.payments import get_client
from app.payments.base import PayPalOutcomeUnknown
from app.services import checkout, jobs, refunds
from app.services.alerts import raise_alert

log = logging.getLogger(__name__)

_TRANSMISSION_HEADERS = ("paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time")


class WebhookRejected(AppError):
    status_code = 400
    code = "webhook_rejected"


def receive(headers: dict[str, str], raw_body: str) -> dict[str, Any]:
    try:
        event = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise WebhookRejected("Body is not JSON") from exc
    event_id = event.get("id")
    if not event_id or not event.get("event_type"):
        raise WebhookRejected("Missing event id or type")
    client = get_client()
    try:
        verified = client.verify_webhook(headers, raw_body)
    except PayPalOutcomeUnknown as exc:
        # Ask PayPal to redeliver later rather than accepting an unverified event.
        raise AppError("Couldn't verify the webhook right now", code="verification_unavailable", status=503) from exc
    if not verified:
        metrics.inc("lastcall_webhooks_total", outcome="rejected")
        log.warning("webhook signature verification failed", extra={"event_type": event.get("event_type")})
        raise WebhookRejected("Signature verification failed")
    resource = event.get("resource") or {}
    lower = {k.lower(): v for k, v in headers.items()}
    row_id = new_id("whk")
    with transaction() as db:
        inserted = db.execute(
            insert(WebhookEvent)
            .values(
                id=row_id,
                provider_event_id=event_id,
                event_type=event["event_type"],
                resource_type=event.get("resource_type"),
                resource_id=resource.get("id"),
                summary=str(event.get("summary", ""))[:300],
                verification="SUCCESS",
                payload=event,
                raw_body=raw_body,
                transmission={k: lower.get(k) for k in _TRANSMISSION_HEADERS if lower.get(k)},
            )
            .on_conflict_do_nothing(index_elements=["provider_event_id"])
            .returning(WebhookEvent.id)
        ).scalar()
        if inserted is None:
            existing = db.scalar(select(WebhookEvent).where(WebhookEvent.provider_event_id == event_id).with_for_update())
            existing.duplicate_count += 1
            metrics.inc("lastcall_webhooks_total", outcome="duplicate")
            return {"status": "duplicate", "event_id": event_id}
        jobs.enqueue("webhooks.process", {"webhook_event_id": row_id}, dedupe_key=f"webhook:{event_id}", db=db)
    metrics.inc("lastcall_webhooks_total", outcome="accepted")
    return {"status": "accepted", "event_id": event_id}


def process(webhook_event_id: str) -> dict[str, Any]:
    with transaction() as db:
        row = db.get(WebhookEvent, webhook_event_id)
        if row is None or row.processed_at is not None:
            return {"result": "already_processed"}
        event_type = row.event_type
        resource = (row.payload or {}).get("resource") or {}
    related = ((resource.get("supplementary_data") or {}).get("related_ids")) or {}
    result = "ignored"
    with transaction() as db:
        attempt = None
        if event_type.startswith("PAYMENT.CAPTURE."):
            attempt = db.scalar(select(PaymentAttempt).where(PaymentAttempt.capture_id == resource.get("id")))
            if attempt is None and related.get("order_id"):
                attempt = db.scalar(select(PaymentAttempt).where(PaymentAttempt.paypal_order_id == related["order_id"]))
        elif event_type.startswith("CHECKOUT.ORDER."):
            attempt = db.scalar(select(PaymentAttempt).where(PaymentAttempt.paypal_order_id == resource.get("id")))
        attempt_id = attempt.id if attempt else None
        pending_refunds = []
        if attempt is not None and event_type in ("PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"):
            pending_refunds = [r.id for r in db.scalars(select(Refund).where(Refund.payment_attempt_id == attempt.id,
                                                                            Refund.state.in_(["REQUESTED", "PENDING", "OUTCOME_UNKNOWN"]))).all()]
    if attempt_id is None:
        result = "unmatched"
    elif event_type in ("PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED",
                        "CHECKOUT.ORDER.COMPLETED", "CHECKOUT.ORDER.APPROVED"):
        result = "reconciled:" + checkout.reconcile_attempt(attempt_id, reason=f"webhook:{event_type}")
    elif event_type in ("PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"):
        outcomes = [refunds.reconcile_refund(rid) for rid in pending_refunds]
        result = "refunds:" + (",".join(outcomes) if outcomes else "none_pending")
        if not pending_refunds:
            with transaction() as db:
                attempt = db.get(PaymentAttempt, attempt_id)
                order = db.get(Order, attempt.order_id)
                raise_alert(db, order.merchant_id, "external_refund", "order", order.id,
                                         f"{order.order_number}: PayPal reports a refund or reversal not started in LastCall. Review it in PayPal.", "high")
    with transaction() as db:
        row = db.get(WebhookEvent, webhook_event_id, with_for_update=True)
        row.processed_at = clock.now()
        row.processing_result = result[:300]
    return {"result": result}


def replay(webhook_event_id: str) -> dict[str, Any]:
    """Ops tool: re-process a stored event (processing is idempotent, so this never double-applies)."""
    with transaction() as db:
        row = db.get(WebhookEvent, webhook_event_id)
        if row is None:
            raise AppError("Webhook event not found", code="not_found", status=404)
        raw, transmission = row.raw_body, dict(row.transmission or {})
    return receive(transmission, raw)


def recent(limit: int = 50) -> list[dict[str, Any]]:
    with transaction() as db:
        rows = db.scalars(select(WebhookEvent).order_by(WebhookEvent.received_at.desc()).limit(limit)).all()
        return [
            {"id": r.id, "provider_event_id": r.provider_event_id, "event_type": r.event_type, "resource_id": r.resource_id,
             "verification": r.verification, "duplicate_count": r.duplicate_count, "received_at": clock.iso(r.received_at),
             "processed_at": clock.iso(r.processed_at), "processing_result": r.processing_result}
            for r in rows
        ]


@jobs.handler("webhooks.process")
def _process(payload: dict[str, Any]) -> dict[str, Any]:
    return process(payload["webhook_event_id"])
