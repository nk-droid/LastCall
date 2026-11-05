"""Test fixtures: a real PostgreSQL with a migrated template database cloned per test and a
frozen clock. Set TEST_DATABASE_ADMIN_URL to use your own server (CI does); otherwise an
embedded PostgreSQL is started for the session."""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from app import clock, db
from app.ai import provider as ai_provider
from app.api.deps import limiter
from app.config import override_settings, reset_settings_override
from app.main import create_app
from app.migrate import upgrade_head

TZ = ZoneInfo("America/Los_Angeles")
# 3:00 PM local on a Tuesday.
FROZEN_AT = datetime(2026, 11, 3, 15, 0, tzinfo=TZ)
APP_ORIGIN = "http://localhost:3787"
ORIGIN = {"Origin": APP_ORIGIN}


def base_settings(**overrides) -> dict:
    """Settings every test starts from; individual tests may override fields."""
    values = dict(
        app_env="test", worker_enabled=False, auto_migrate=False, secret_key="test-secret-key",
        public_app_url=APP_ORIGIN, log_json=False, llm_provider="none", ai_bundle_rationale=True,
    )
    values.update(overrides)
    return values


@pytest.fixture(scope="session")
def pg_admin_url(tmp_path_factory) -> Iterator[str]:
    url = os.environ.get("TEST_DATABASE_ADMIN_URL")
    if url:
        yield db.normalize_url(url)
        return
    data_dir = tmp_path_factory.mktemp("pg")
    yield db.normalize_url(db.embedded_server_uri(data_dir, database="postgres"))


def _db_url(admin_url: str, name: str) -> str:
    base, _, rest = admin_url.partition("?")
    return base.rsplit("/", 1)[0] + f"/{name}" + (f"?{rest}" if rest else "")


@pytest.fixture(scope="session")
def template_db(pg_admin_url: str) -> str:
    name = f"lastcall_template_{uuid.uuid4().hex[:6]}"
    admin = create_engine(pg_admin_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    admin.dispose()
    upgrade_head(_db_url(pg_admin_url, name))
    yield name
    admin = create_engine(pg_admin_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    admin.dispose()


@pytest.fixture(autouse=True)
def env(pg_admin_url: str, template_db: str, tmp_path) -> Iterator[str]:
    name = f"t_{uuid.uuid4().hex[:12]}"
    admin = create_engine(pg_admin_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}" TEMPLATE "{template_db}"'))
    url = _db_url(pg_admin_url, name)
    override_settings(**base_settings(database_url=url, data_dir=tmp_path))
    ai_provider.set_provider(None)
    limiter.reset()
    clock.freeze(FROZEN_AT)
    db.configure(url)
    yield url
    clock.reset()
    db.engine().dispose()
    ai_provider.clear_provider_override()
    reset_settings_override()
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    admin.dispose()


@pytest.fixture
def fixture_llm() -> ai_provider.FixtureProvider:
    """A scripted model: queue replies per task, then the code under test calls it like the real one."""
    fake = ai_provider.FixtureProvider()
    ai_provider.set_provider(fake)
    return fake


@pytest.fixture
def bakery() -> str:
    """Juniper & Rye Bakehouse, live, with today's surplus listed. Returns the merchant id."""
    from .fixtures import seed_bakery

    return seed_bakery()


@pytest.fixture
def app():
    return create_app()


def new_client(app) -> TestClient:
    client = TestClient(app, base_url="http://testserver")
    client.headers.update(ORIGIN)
    client.get("/api/config")  # establishes the shopper session cookie
    return client


@pytest.fixture
def client(app) -> TestClient:
    return new_client(app)
