"""Alembic environment: migrates whichever database the app resolves (DATABASE_URL or embedded)."""

from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine, pool

from app.db import resolve_database_url
from app.models import Base

config = context.config
target_metadata = Base.metadata


def _url() -> str:
    return config.attributes.get("database_url") or resolve_database_url()


def run_migrations_offline() -> None:
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connection = config.attributes.get("connection")
    if connection is not None:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
        return
    engine = create_engine(_url(), poolclass=pool.NullPool)
    with engine.connect() as conn:
        context.configure(connection=conn, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
