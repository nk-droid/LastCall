"""Operational commands: python -m app.cli {migrate|create-admin|seed-showcase|run-due|worker}."""

from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path

from app import db
from app.config import settings
from app.migrate import upgrade_head
from app.observability import setup_logging
from app.seed import showcase
from app.services import accounts, jobs
from app.worker import run_forever


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("migrate", help="Apply database migrations")
    admin = sub.add_parser("create-admin", help="Create or promote a platform administrator")
    admin.add_argument("--email", required=True)
    admin.add_argument("--name", default="LastCall Admin")
    seed = sub.add_parser("seed-showcase", help="Create the showcase shops (idempotent); staff accounts need SHOWCASE_PASSWORD")
    seed.add_argument("--photos", type=Path, help="Folder of <slug>/<SKU>.jpg|png|webp photos (optional credits.json)")
    seed.add_argument("--pexels", action="store_true", help="Fetch missing photos from Pexels (needs PEXELS_API_KEY)")
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
    elif args.command == "create-admin":
        password = os.environ.get("ADMIN_PASSWORD") or getpass.getpass("Password for the admin account: ")
        result = accounts.ensure_platform_admin(email=args.email, name=args.name, password=password)
        print(f"platform admin ready: {result['email']}")
    elif args.command == "seed-showcase":
        result = showcase.seed(password=os.environ.get("SHOWCASE_PASSWORD"), photos=args.photos,
                               pexels_key=os.environ.get("PEXELS_API_KEY") if args.pexels else None)
        print(json.dumps(result, indent=2))
    elif args.command == "run-due":
        print(f"ran {jobs.run_due('cli')} job(s)")
    elif args.command == "worker":
        run_forever()


if __name__ == "__main__":
    main()
