#!/usr/bin/env python3
"""
Delete all application data: parent_emails, attachments, vessels (CASCADE).

Loads the same PG_* variables as the backend from backend/.env.

Usage (from repo root, venv activated):
  python clear_database.py          # prompts for confirmation
  python clear_database.py --yes    # no prompt
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"


def main() -> None:
    parser = argparse.ArgumentParser(description="Truncate all email parser tables.")
    parser.add_argument(
        "--yes", "-y",
        action="store_true",
        help="Skip confirmation prompt.",
    )
    args = parser.parse_args()

    if not BACKEND.is_dir():
        print("ERROR: backend/ folder not found next to this script.", file=sys.stderr)
        sys.exit(1)

    os.chdir(BACKEND)
    sys.path.insert(0, str(BACKEND))

    import psycopg2

    from config import settings

    dsn = (
        f"host={settings.PG_HOST} "
        f"port={settings.PG_PORT} "
        f"dbname={settings.PG_DATABASE} "
        f"user={settings.PG_USER} "
        f"password={settings.PG_PASSWORD}"
    )

    if not args.yes:
        print(
            f"This will DELETE ALL ROWS in parent_emails (and cascaded attachments + vessels)\n"
            f"  Database: {settings.PG_HOST}:{settings.PG_PORT} / {settings.PG_DATABASE}\n"
        )
        reply = input("Type YES to continue: ").strip()
        if reply != "YES":
            print("Aborted.")
            sys.exit(0)

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE TABLE parent_emails CASCADE;")
        conn.commit()
        print("Done. All parent_emails, attachments, and vessels removed.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
