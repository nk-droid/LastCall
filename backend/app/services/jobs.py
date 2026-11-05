"""Durable job queue (PostgreSQL) and the background worker.

Jobs survive restarts; claiming uses FOR UPDATE SKIP LOCKED so several workers (or API
instances) can run. Periodic jobs are enqueued once per interval bucket under a dedupe key,
so scaling out never runs the same tick twice. Feature modules register their own handlers
with ``@handler(kind, every=seconds)``; ``app.services.job_handlers`` imports them.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.models import Job, SystemState
from app.observability import metrics

log = logging.getLogger(__name__)

JobFn = Callable[[dict[str, Any]], dict[str, Any] | None]

HANDLERS: dict[str, JobFn] = {}
# kind -> interval in seconds, for handlers registered with ``every=``.
PERIODIC: dict[str, int] = {}


class RetryLater(Exception):
    """Transient condition (e.g. PayPal unreachable); retry with backoff."""


def handler(kind: str, *, every: int | None = None) -> Callable[[JobFn], JobFn]:
    def register(fn: JobFn) -> JobFn:
        HANDLERS[kind] = fn
        if every:
            PERIODIC[kind] = every
        return fn

    return register


def enqueue(kind: str, payload: dict[str, Any] | None = None, *, delay_seconds: float = 0,
            dedupe_key: str | None = None, max_attempts: int = 8, db: Session | None = None) -> None:
    stmt = (
        insert(Job)
        .values(
            kind=kind,
            payload=payload or {},
            dedupe_key=dedupe_key,
            state="queued",
            run_at=clock.now() + timedelta(seconds=delay_seconds),
            attempts=0,
            max_attempts=max_attempts,
        )
        .on_conflict_do_nothing(index_elements=["dedupe_key"])
    )
    if db is not None:
        db.execute(stmt)
    else:
        with transaction() as session:
            session.execute(stmt)


def _schedule_periodic(now: datetime) -> None:
    for kind, interval in PERIODIC.items():
        bucket = int(now.timestamp() // interval)
        enqueue(kind, {}, dedupe_key=f"periodic:{kind}:{bucket}", max_attempts=1)


def _reclaim_stale(now: datetime) -> None:
    with transaction() as db:
        stale = db.scalars(
            select(Job).where(Job.state == "running", Job.locked_at < now - timedelta(minutes=5)).with_for_update(skip_locked=True)
        ).all()
        for job in stale:
            job.state = "queued"
            job.locked_at = None
            job.locked_by = None


def _claim(now: datetime, worker_name: str) -> tuple[int, str, dict[str, Any], int, int] | None:
    with transaction() as db:
        job = db.scalar(
            select(Job)
            .where(Job.state == "queued", Job.run_at <= now)
            .order_by(Job.run_at, Job.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        if job is None:
            return None
        job.state = "running"
        job.locked_at = now
        job.locked_by = worker_name
        job.attempts += 1
        return job.id, job.kind, dict(job.payload or {}), job.attempts, job.max_attempts


def _finish(job_id: int, *, state: str, result: dict[str, Any] | None = None, error: str | None = None,
            retry_at: datetime | None = None) -> None:
    with transaction() as db:
        job = db.get(Job, job_id, with_for_update=True)
        if job is None:
            return
        job.state = state
        job.locked_at = None
        job.locked_by = None
        if result is not None:
            job.result = result
        if error is not None:
            job.last_error = error[:2000]
        if retry_at is not None:
            job.run_at = retry_at
        if state in ("done", "dead") and job.dedupe_key and not job.dedupe_key.startswith("periodic:"):
            job.dedupe_key = None  # allow the same logical job to be enqueued again later


def run_job(job_id: int, kind: str, payload: dict[str, Any], attempts: int, max_attempts: int) -> None:
    fn = HANDLERS.get(kind)
    if fn is None:
        _finish(job_id, state="dead", error=f"no handler for {kind}")
        return
    try:
        result = fn(payload) or {}
        _finish(job_id, state="done", result=result)
        metrics.inc("lastcall_jobs_total", kind=kind, outcome="done")
    except RetryLater as exc:
        backoff = min(300, 2 ** attempts)
        state = "dead" if attempts >= max_attempts else "queued"
        _finish(job_id, state=state, error=f"retry: {exc}", retry_at=clock.now() + timedelta(seconds=backoff))
        metrics.inc("lastcall_jobs_total", kind=kind, outcome="retry")
    except Exception as exc:  # noqa: BLE001 - the worker must survive any handler failure
        log.exception("job failed", extra={"job_kind": kind, "job_id": job_id})
        backoff = min(300, 2 ** attempts)
        state = "dead" if attempts >= max_attempts else "queued"
        _finish(job_id, state=state, error=f"{exc.__class__.__name__}: {exc}", retry_at=clock.now() + timedelta(seconds=backoff))
        metrics.inc("lastcall_jobs_total", kind=kind, outcome="error")


def run_due(worker_name: str = "inline", limit: int = 100, include_periodic: bool = True) -> int:
    from app.services import job_handlers  # noqa: F401, PLC0415 - registers handlers; they import this module

    now = clock.now()
    if include_periodic:
        _schedule_periodic(now)
    _reclaim_stale(now)
    ran = 0
    while ran < limit:
        claimed = _claim(clock.now(), worker_name)
        if claimed is None:
            break
        run_job(*claimed)
        ran += 1
    _heartbeat(worker_name, ran)
    return ran


def _heartbeat(worker_name: str, ran: int) -> None:
    with transaction() as db:
        state = db.get(SystemState, "worker_heartbeat", with_for_update=True)
        value = {"at": clock.iso(clock.now()), "worker": worker_name, "last_batch": ran}
        if state is None:
            db.add(SystemState(key="worker_heartbeat", value=value))
        else:
            state.value = value


def cleanup(older_than: timedelta = timedelta(days=1)) -> int:
    with transaction() as db:
        result = db.execute(delete(Job).where(Job.state.in_(["done", "dead"]), Job.updated_at < clock.now() - older_than))
        return result.rowcount or 0


@handler("jobs.cleanup", every=3600)
def _cleanup(_: dict[str, Any]) -> dict[str, Any]:
    return {"deleted": cleanup()}


class Worker:
    def __init__(self, interval_seconds: float = 2.0):
        self.interval = interval_seconds
        self.name = f"{socket.gethostname()}:{os.getpid()}"
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name="lastcall-worker", daemon=True)
        self._thread.start()
        log.info("worker started", extra={"worker": self.name})

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                run_due(self.name)
            except Exception:  # noqa: BLE001
                log.exception("worker loop error")
            self._stop.wait(self.interval)
