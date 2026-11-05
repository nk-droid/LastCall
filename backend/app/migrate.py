"""Programmatic Alembic upgrade, serialized with a PostgreSQL advisory lock."""

from __future__ import annotations

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, pool, text

from app.config import BACKEND_DIR
from app.db import resolve_database_url

_LOCK_ID = 842_113


def alembic_config() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    return cfg


def upgrade_head(url: str | None = None) -> None:
    engine = create_engine(url or resolve_database_url(), poolclass=pool.NullPool)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT pg_advisory_lock(:id)"), {"id": _LOCK_ID})
            try:
                cfg = alembic_config()
                cfg.attributes["connection"] = conn
                command.upgrade(cfg, "head")
                conn.commit()
            finally:
                conn.execute(text("SELECT pg_advisory_unlock(:id)"), {"id": _LOCK_ID})
                conn.commit()
    finally:
        engine.dispose()


def current_revision(url: str | None = None) -> str | None:
    engine = create_engine(url or resolve_database_url(), poolclass=pool.NullPool)
    try:
        with engine.connect() as conn:
            return conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
    except Exception:  # noqa: BLE001 - table missing before the first migration
        return None
    finally:
        engine.dispose()
