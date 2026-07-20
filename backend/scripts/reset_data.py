"""
Wipe all fetched/extracted data so you can run a clean fetch again.

Run from the backend/ directory:

    python -m scripts.reset_data            # clears emails, attachments, vessels, contacts
    python -m scripts.reset_data --library  # also clears the vessel_library table
    python -m scripts.reset_data --yes      # skip the confirmation prompt

What it does NOT touch:
  - column_definitions  (the grid headers — they are re-seeded automatically on startup)
  - the database/tables themselves (only the rows are removed)
"""
import argparse
import logging
import os
import sys

import psycopg2

# Allow running as `python scripts/reset_data.py` from backend/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import settings  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
logger = logging.getLogger("reset_data")

# parent_emails is the root; CASCADE clears attachments + vessels automatically,
# but we list them all explicitly for clarity.
BASE_TABLES = ["parent_emails", "attachments", "vessels", "broker_contacts"]


def main() -> None:
    parser = argparse.ArgumentParser(description="Clear fetched/extracted rows from the DB.")
    parser.add_argument("--library", action="store_true", help="also clear vessel_library")
    parser.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    args = parser.parse_args()

    tables = list(BASE_TABLES)
    if args.library:
        tables.append("vessel_library")

    logger.info("Target DB : %s:%s / %s", settings.PG_HOST, settings.PG_PORT, settings.PG_DATABASE)
    logger.info("Tables    : %s", ", ".join(tables))

    if not args.yes:
        reply = input("This permanently deletes ALL rows in those tables. Type 'yes' to continue: ")
        if reply.strip().lower() != "yes":
            logger.info("Aborted — nothing was deleted.")
            return

    conn = psycopg2.connect(
        host=settings.PG_HOST,
        port=settings.PG_PORT,
        dbname=settings.PG_DATABASE,
        user=settings.PG_USER,
        password=settings.PG_PASSWORD,
    )
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "TRUNCATE " + ", ".join(tables) + " RESTART IDENTITY CASCADE;"
            )
        logger.info("Done — %d table(s) cleared. Restart the backend and fetch again.", len(tables))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
