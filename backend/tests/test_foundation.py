"""Platform foundation: health, metrics protection, CSRF origin checks, the audit trail and the job queue."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app import clock
from app.config import override_settings, settings
from app.db import transaction
from app.models import AuditEvent, Job
from app.services import audit, jobs

from .conftest import base_settings


def test_health_reports_database_and_migrations(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["checks"]["database"]["ok"] is True
    assert body["checks"]["migrations"]["revision"]
    assert client.get("/api/health/live").json() == {"status": "ok"}


def test_api_responses_carry_security_headers(client):
    response = client.get("/api/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-request-id"]


def test_metrics_require_token_when_configured(client, env, tmp_path):
    assert client.get("/api/metrics").status_code == 200  # open outside production without a token
    override_settings(**base_settings(database_url=env, data_dir=tmp_path, metrics_token="s3cret"))
    assert client.get("/api/metrics").status_code == 401
    assert client.get("/api/metrics", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/api/metrics", headers={"Authorization": "Bearer s3cret"}).status_code == 200


def test_metrics_hidden_in_production_without_token(client, env, tmp_path):
    override_settings(**base_settings(database_url=env, data_dir=tmp_path, app_env="production",
                                      public_app_url="https://lastcall.example"))
    assert client.get("/api/metrics").status_code == 404


def test_cross_site_unsafe_requests_are_blocked(client):
    response = client.post("/api/health", headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_rejected"


def test_production_requires_secrets(env, tmp_path):
    s = override_settings(**base_settings(database_url=None, data_dir=tmp_path, app_env="production", secret_key=None,
                                          public_app_url="https://lastcall.example"))
    with pytest.raises(RuntimeError, match="DATABASE_URL, SECRET_KEY"):
        s.validate_for_startup()
    s = override_settings(**base_settings(database_url=env, data_dir=tmp_path, app_env="production", public_app_url="http://lastcall.example"))
    with pytest.raises(RuntimeError, match="https"):
        s.validate_for_startup()
    assert settings().is_production


def test_audit_events_are_append_only():
    with transaction() as db:
        audit.record(db, actor="system:test", actor_role="system", entity_type="thing", entity_id="t1", action="created",
                     meta={"email": "someone@example.com"})
    with transaction() as db:
        event = db.scalar(select(AuditEvent))
        assert event.meta == {"email": "[redacted]"}
    with pytest.raises(DBAPIError, match="append-only"):
        with transaction() as db:
            db.execute(text("UPDATE audit_events SET action = 'tampered'"))
    with pytest.raises(DBAPIError, match="append-only"):
        with transaction() as db:
            db.execute(text("DELETE FROM audit_events"))


def test_job_queue_runs_retries_and_dedupes():
    calls: list[dict] = []

    @jobs.handler("test.flaky")
    def flaky(payload):
        calls.append(payload)
        if len(calls) == 1:
            raise jobs.RetryLater("provider unreachable")
        return {"ok": True}

    jobs.enqueue("test.flaky", {"n": 1}, dedupe_key="flaky:1")
    jobs.enqueue("test.flaky", {"n": 1}, dedupe_key="flaky:1")  # same logical job: ignored
    assert jobs.run_due("test", include_periodic=False) == 1
    with transaction() as db:
        job = db.scalar(select(Job).where(Job.kind == "test.flaky"))
        assert job.state == "queued" and job.attempts == 1 and "provider unreachable" in job.last_error
    assert jobs.run_due("test", include_periodic=False) == 0  # backoff not elapsed
    clock.advance(timedelta(seconds=5))
    assert jobs.run_due("test", include_periodic=False) == 1
    with transaction() as db:
        job = db.scalar(select(Job).where(Job.kind == "test.flaky"))
        assert job.state == "done" and job.result == {"ok": True}
    assert len(calls) == 2
    jobs.HANDLERS.pop("test.flaky")


def test_periodic_jobs_enqueue_once_per_interval():
    jobs.run_due("a")
    jobs.run_due("b")  # a second worker in the same tick adds nothing
    with transaction() as db:
        cleanups = db.scalars(select(Job).where(Job.kind == "jobs.cleanup")).all()
    assert len(cleanups) == 1 and cleanups[0].state == "done"
