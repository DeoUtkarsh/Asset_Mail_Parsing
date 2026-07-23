"""
Sync vessel_library from vessels already in the DB.

Run from the backend/ directory:

    python -m scripts.autofill_vessel_library

Idempotent:
  - inserts vessels not already in the library (IMO / name match)
  - fills blank fields on existing library rows from extraction data
"""
import logging
import os
import sys

# Allow running as `python scripts/autofill_vessel_library.py` from backend/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database import supabase  # noqa: E402
from vessel_library import autofill_library, list_library  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
logger = logging.getLogger("autofill_vessel_library")


def main() -> None:
    before = len(list_library(supabase))
    stats = autofill_library(supabase)
    after = len(list_library(supabase))
    logger.info(
        "Vessel library: %d existing → +%d inserted, %d updated → %d total",
        before,
        stats.get("inserted", 0),
        stats.get("updated", 0),
        after,
    )


if __name__ == "__main__":
    main()
