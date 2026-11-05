"""Standalone background worker process (use with WORKER_ENABLED=false on the API server)."""

from __future__ import annotations

import logging
import signal
import threading

from app import db
from app.config import settings
from app.observability import setup_logging
from app.services.jobs import run_due

log = logging.getLogger("lastcall.worker")


def run_forever() -> None:
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    interval = settings().worker_interval_seconds
    log.info("worker running", extra={"interval_seconds": interval})
    while not stop.is_set():
        try:
            run_due("standalone")
        except Exception:  # noqa: BLE001
            log.exception("worker iteration failed")
        stop.wait(interval)


if __name__ == "__main__":
    s = settings()
    setup_logging(s.log_level, s.log_json)
    db.configure()
    run_forever()
