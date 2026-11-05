"""Operational commands: python -m app.cli {migrate|run-due|worker}."""

from __future__ import annotations

import argparse

from app import db
from app.config import settings
from app.migrate import upgrade_head
from app.observability import setup_logging
from app.services import jobs
from app.worker import run_forever


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("migrate", help="Apply database migrations")
    sub.add_parser("run-due", help="Run due background jobs once")
    sub.add_parser("worker", help="Run the background worker in the foreground")
    args = parser.parse_args()

    s = settings()
    setup_logging(s.log_level, as_json=False)
    s.validate_for_startup()
    db.configure()
    upgrade_head()
    if args.command == "migrate":
        print("migrations applied")
    elif args.command == "run-due":
        print(f"ran {jobs.run_due('cli')} job(s)")
    elif args.command == "worker":
        run_forever()


if __name__ == "__main__":
    main()
