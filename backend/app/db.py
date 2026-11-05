"""Database engine and transaction helpers.

Services own their transaction boundaries explicitly via ``transaction()``; every
stock- or money-affecting change happens inside one, with row locks where needed.
Production always uses DATABASE_URL; the embedded server is a development convenience.
"""

from __future__ import annotations

import hashlib
import logging
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

log = logging.getLogger(__name__)

_lock = threading.Lock()
_state: dict[str, object] = {}
_embedded: dict[str, object] = {}

DATABASE_NAME = "lastcall"


def normalize_url(url: str) -> str:
    """Accept postgres:// / postgresql:// URLs and select the psycopg 3 driver."""
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


def _patch_socket_dir() -> None:
    """pg_ctl passes the socket directory inside a space-separated option string, so a project
    path containing spaces breaks startup. Keep the data directory where it is, but place the
    Unix socket in a whitespace-free directory."""
    import pgserver.postgres_server as ps  # noqa: PLC0415

    if getattr(ps, "_lastcall_patched", False):
        return
    original = ps.find_suitable_socket_dir

    def socket_dir(pgdata: Path, runtime_path: Path) -> Path:
        chosen = original(pgdata, runtime_path)
        if not any(ch.isspace() for ch in str(chosen)):
            return chosen
        digest = hashlib.sha256(str(pgdata).encode()).hexdigest()[:10]
        for candidate in (Path(runtime_path) / digest, Path(tempfile.gettempdir()) / f"lastcall-pg-{digest}"):
            if not any(ch.isspace() for ch in str(candidate)) and len(str(candidate / ".s.PGSQL.5432")) < 100:
                candidate.mkdir(parents=True, exist_ok=True)
                return candidate
        return chosen

    ps.find_suitable_socket_dir = socket_dir
    ps._lastcall_patched = True


def embedded_server_uri(data_dir: Path, database: str = DATABASE_NAME) -> str:
    """Start (or attach to) the embedded PostgreSQL server and ensure ``database`` exists."""
    import pgserver  # noqa: PLC0415 - lazy: only needed without DATABASE_URL

    _patch_socket_dir()
    key = str(data_dir.resolve())
    server = _embedded.get(key)
    if server is None:
        data_dir.mkdir(parents=True, exist_ok=True)
        server = pgserver.get_server(data_dir, cleanup_mode="stop")
        _embedded[key] = server
    admin_uri = server.get_uri()
    admin = create_engine(normalize_url(admin_uri), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            exists = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": database}
            ).scalar()
            if not exists:
                conn.execute(text(f'CREATE DATABASE "{database}"'))
    finally:
        admin.dispose()
    return server.get_uri(database=database)


def resolve_database_url() -> str:
    s = settings()
    if s.database_url:
        return normalize_url(s.database_url)
    if s.is_production:
        raise RuntimeError("DATABASE_URL must be set in production")
    return normalize_url(embedded_server_uri(s.data_dir / "pg"))


def configure(url: str | None = None) -> Engine:
    """(Re)create the global engine. Tests call this with a per-test database URL."""
    with _lock:
        old = _state.get("engine")
        if isinstance(old, Engine):
            old.dispose()
        resolved = url or resolve_database_url()
        s = settings()
        engine = create_engine(
            resolved,
            pool_size=s.database_pool_size,
            max_overflow=s.database_max_overflow,
            pool_pre_ping=True,
            pool_recycle=1800,
            future=True,
        )
        _state["engine"] = engine
        _state["sessionmaker"] = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        safe = make_url(resolved).render_as_string(hide_password=True)
        log.info("database configured", extra={"database": safe})
        return engine


def engine() -> Engine:
    eng = _state.get("engine")
    if eng is None:
        eng = configure()
    return eng  # type: ignore[return-value]


def _sessionmaker() -> sessionmaker[Session]:
    if "sessionmaker" not in _state:
        configure()
    return _state["sessionmaker"]  # type: ignore[return-value]


@contextmanager
def transaction() -> Iterator[Session]:
    """One atomic unit of work: commits on success, rolls back on any exception."""
    session = _sessionmaker()()
    try:
        with session.begin():
            yield session
    finally:
        session.close()


@contextmanager
def read_session() -> Iterator[Session]:
    session = _sessionmaker()()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def libpq_dsn() -> str:
    """The engine's database as a plain libpq connection string (for LISTEN connections)."""
    return engine().url.render_as_string(hide_password=False).replace("postgresql+psycopg://", "postgresql://", 1)


def ping() -> bool:
    with engine().connect() as conn:
        return conn.execute(text("SELECT 1")).scalar() == 1
