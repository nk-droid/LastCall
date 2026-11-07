"""Platform operations, limited to LastCall administrators: shop review, the payment/webhook/AI evidence trail,
background jobs, traces, the audit log and (when enabled) PayPal failure injection."""

from __future__ import annotations

import statistics
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app import clock
from app.ai.agent import run_view
from app.api.deps import platform_admin
from app.config import settings
from app.db import transaction
from app.errors import Forbidden, NotFound
from app.models import AgentRun, AgentStep, AIInvocation, AuditEvent, EmailMessage, Job, Merchant, Order, PaymentAttempt, SystemState
from app.payments import faults
from app.services import checkout, jobs, overview, shops, webhooks
from app.services.accounts import SessionUser

router = APIRouter(prefix="/api/ops", tags=["ops"])


class ApproveBody(BaseModel):
    checks: list[str]


class NoteBody(BaseModel):
    note: str = Field(min_length=3, max_length=1000)


@router.get("/shops")
def shop_queue(status: str | None = None, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.review_queue(status)


@router.get("/shops/{merchant_id}")
def shop_detail(merchant_id: str, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.review_detail(merchant_id)


@router.post("/shops/{merchant_id}/approve")
def approve(merchant_id: str, body: ApproveBody, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.approve(admin, merchant_id, body.checks)


@router.post("/shops/{merchant_id}/reject")
def reject(merchant_id: str, body: NoteBody, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.reject(admin, merchant_id, body.note)


@router.post("/shops/{merchant_id}/suspend")
def suspend(merchant_id: str, body: NoteBody, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.suspend(admin, merchant_id, body.note)


@router.post("/shops/{merchant_id}/reinstate")
def reinstate(merchant_id: str, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return shops.reinstate(admin, merchant_id)


# --------------------------------------------------------------------------- platform status


@router.get("/status")
def status(admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    with transaction() as db:
        day_start = clock.now().replace(hour=0, minute=0, second=0, microsecond=0)
        by_status = dict(db.execute(select(Merchant.status, func.count()).group_by(Merchant.status)).all())
        captured_today = db.scalar(select(func.count()).select_from(Order).where(Order.payment_status == "CAPTURED", Order.confirmed_at >= day_start))
        unresolved = db.scalar(select(func.count()).select_from(PaymentAttempt).where(PaymentAttempt.state.in_(list(checkout.IN_FLIGHT_STATES))))
        heartbeat = db.get(SystemState, "worker_heartbeat")
        connection = db.get(SystemState, "paypal_connection")
        dead_jobs = db.scalar(select(func.count()).select_from(Job).where(Job.state == "dead"))
        return {
            "shops": by_status, "orders_captured_today_utc": captured_today, "payments_unresolved": unresolved,
            "worker": heartbeat.value if heartbeat else None, "paypal": connection.value if connection else None,
            "jobs_dead": dead_jobs, "faults_enabled": settings().ops_faults_enabled, "as_of": clock.iso(clock.now()),
        }


@router.post("/paypal/check")
def paypal_check(admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return overview.check_paypal_connection()


# --------------------------------------------------------------------------- payments + webhooks


@router.get("/payments")
def payments(admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    with transaction() as db:
        rows = db.execute(
            select(PaymentAttempt, Order, Merchant).join(Order, Order.id == PaymentAttempt.order_id).join(Merchant, Merchant.id == Order.merchant_id)
            .order_by(PaymentAttempt.created_at.desc()).limit(50)
        ).all()
        return {"payments": [
            {"id": a.id, "order_id": o.id, "order_number": o.order_number, "merchant": {"slug": m.slug, "name": m.name},
             "state": a.state, "order_payment_status": o.payment_status, "environment": a.environment, "payee": a.payee,
             "paypal_order_id": a.paypal_order_id, "capture_id": a.capture_id, "request_id": a.request_id,
             "capture_request_id": a.capture_request_id, "amount_minor": a.amount_minor, "currency": a.currency, "provider_state": a.provider_state,
             "last_error": a.last_error, "reconcile_count": a.reconcile_count, "created_at": clock.iso(a.created_at), "captured_at": clock.iso(a.captured_at),
             "trace_id": o.trace_id}
            for a, o, m in rows
        ]}


@router.post("/payments/{attempt_id}/reconcile")
def reconcile(attempt_id: str, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    with transaction() as db:
        if db.get(PaymentAttempt, attempt_id) is None:
            raise NotFound("Payment attempt not found")
    try:
        result = checkout.reconcile_attempt(attempt_id, reason="ops")
    except jobs.RetryLater as exc:
        result = f"PayPal unreachable, will retry: {exc}"
    return {"result": result}


@router.get("/webhooks")
def webhook_events(admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return {"events": webhooks.recent()}


@router.post("/webhooks/{webhook_event_id}/replay")
def replay(webhook_event_id: str, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return webhooks.replay(webhook_event_id)


# --------------------------------------------------------------------------- AI calls + jobs


@router.get("/ai-invocations")
def ai_invocations(admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    with transaction() as db:
        rows = db.scalars(select(AIInvocation).order_by(AIInvocation.created_at.desc()).limit(60)).all()
        return {"invocations": [
            {"id": r.id, "task": r.task, "prompt_version": r.prompt_version, "validation_result": r.validation_result,
             "failure_reason": r.failure_reason, "latency_ms": r.latency_ms, "input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
             "repaired": r.repaired, "fallback_used": r.fallback_used, "input_hash": r.input_hash[:12], "agent_run_id": r.agent_run_id,
             "created_at": clock.iso(r.created_at)}
            for r in rows
        ]}


@router.get("/agent-runs")
def agent_runs(kind: str | None = None, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    """Recent agent runs with their step traces and model turns, newest first, plus the last 24 hours at a glance."""
    with transaction() as db:
        query = select(AgentRun).order_by(AgentRun.created_at.desc()).limit(40)
        if kind:
            query = query.where(AgentRun.kind == kind)
        runs = db.scalars(query).all()
        ids = [r.id for r in runs]
        steps = db.scalars(select(AgentStep).where(AgentStep.run_id.in_(ids)).order_by(AgentStep.idx)).all() if runs else []
        turns = _turns(db, ids)
        by_run: dict[str, list[AgentStep]] = {}
        for st in steps:
            by_run.setdefault(st.run_id, []).append(st)
        return {"runs": [run_view(r, by_run.get(r.id, []), turns.get(r.id, [])) for r in runs], "stats": _run_stats(db, kind)}


@router.get("/agent-runs/{run_id}")
def agent_run(run_id: str, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    with transaction() as db:
        run = db.get(AgentRun, run_id)
        if run is None:
            raise NotFound("Agent run not found")
        steps = db.scalars(select(AgentStep).where(AgentStep.run_id == run_id).order_by(AgentStep.idx)).all()
        return run_view(run, list(steps), _turns(db, [run_id]).get(run_id, []))


def _turns(db, run_ids: list[str]) -> dict[str, list[AIInvocation]]:
    """Each run's model turns in the order they happened."""
    if not run_ids:
        return {}
    rows = db.scalars(select(AIInvocation).where(AIInvocation.agent_run_id.in_(run_ids))
                      .order_by(AIInvocation.offset_ms.asc().nulls_last(), AIInvocation.created_at, AIInvocation.id)).all()
    out: dict[str, list[AIInvocation]] = {}
    for row in rows:
        out.setdefault(row.agent_run_id, []).append(row)
    return out


FAILED_RUNS = ("error", "timeout", "step_limit")


def _run_stats(db, kind: str | None) -> dict[str, Any]:
    since = clock.now() - timedelta(hours=24)
    query = select(AgentRun.status, AgentRun.latency_ms, AgentRun.input_tokens, AgentRun.output_tokens).where(
        AgentRun.created_at >= since, AgentRun.status != "running")
    if kind:
        query = query.where(AgentRun.kind == kind)
    rows = db.execute(query).all()
    times = sorted(r.latency_ms for r in rows if r.status not in ("fallback",))
    return {
        "runs": len(rows),
        "median_ms": statistics.median(times) if times else None,
        "failed": sum(1 for r in rows if r.status in FAILED_RUNS),
        "input_tokens": sum(r.input_tokens or 0 for r in rows),
        "output_tokens": sum(r.output_tokens or 0 for r in rows),
    }


@router.get("/jobs")
def job_list(admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    periodic = list(jobs.PERIODIC)
    with transaction() as db:
        rows = db.scalars(select(Job).where(~Job.kind.in_(periodic) | (Job.state != "done")).order_by(Job.created_at.desc()).limit(60)).all()
        return {"jobs": [
            {"id": j.id, "kind": j.kind, "state": j.state, "attempts": j.attempts, "run_at": clock.iso(j.run_at), "last_error": j.last_error,
             "result": j.result, "created_at": clock.iso(j.created_at)}
            for j in rows
        ], "periodic": jobs.PERIODIC}


@router.post("/jobs/run-due")
def run_due(admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return {"ran": jobs.run_due(worker_name=f"ops:{admin.email}")}


# --------------------------------------------------------------------------- failure injection


class FaultRequest(BaseModel):
    kind: str = Field(max_length=40)
    count: int = Field(default=1, ge=1, le=5)


@router.get("/faults")
def list_faults(admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    return {"enabled": settings().ops_faults_enabled, "armed": faults.armed(), "available": faults.FAULT_KINDS}


@router.post("/faults")
def arm_fault(req: FaultRequest, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    if not settings().ops_faults_enabled:
        raise Forbidden("Failure injection is disabled on this deployment (OPS_FAULTS_ENABLED)", code="faults_disabled")
    if req.kind not in faults.FAULT_KINDS:
        raise NotFound("Unknown fault")
    return faults.arm(req.kind, f"admin:{admin.email}", req.count)


@router.delete("/faults")
def clear_faults(admin: SessionUser = Depends(platform_admin)) -> dict[str, str]:
    faults.disarm_all()
    return {"status": "cleared"}


# --------------------------------------------------------------------------- trace + audit


@router.get("/trace/{trace_id}")
def trace(trace_id: str, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    """quote -> reservation -> PayPal -> fulfillment, in order, for one basket lineage."""
    with transaction() as db:
        events = db.scalars(select(AuditEvent).where(AuditEvent.trace_id == trace_id).order_by(AuditEvent.timestamp, AuditEvent.id)).all()
        return {"trace_id": trace_id, "events": [
            {"at": clock.iso(e.timestamp), "actor": e.actor, "entity_type": e.entity_type, "entity_id": e.entity_id, "action": e.action,
             "meta": e.meta, "correlation_id": e.correlation_id}
            for e in events
        ]}


@router.get("/audit")
def audit_log(limit: int = 100, admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    with transaction() as db:
        events = db.scalars(select(AuditEvent).order_by(AuditEvent.id.desc()).limit(min(max(limit, 1), 500))).all()
        return {"events": [
            {"id": e.id, "at": clock.iso(e.timestamp), "actor": e.actor, "role": e.actor_role, "entity_type": e.entity_type, "entity_id": e.entity_id,
             "action": e.action, "meta": e.meta, "trace_id": e.trace_id}
            for e in events
        ]}


@router.get("/emails")
def emails(admin: SessionUser = Depends(platform_admin)) -> dict[str, Any]:
    """Outbox metadata (bodies carry secret links and codes, so they aren't listed)."""
    with transaction() as db:
        rows = db.scalars(select(EmailMessage).order_by(EmailMessage.created_at.desc()).limit(60)).all()
        return {"configured": settings().mail_configured, "emails": [
            {"id": m.id, "to": m.to_email, "template": m.template, "subject": m.subject, "status": m.status, "attempts": m.attempts,
             "last_error": m.last_error, "created_at": clock.iso(m.created_at), "sent_at": clock.iso(m.sent_at)} for m in rows]}
