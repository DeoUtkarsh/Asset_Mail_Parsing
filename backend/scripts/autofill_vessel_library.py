"""
One-off script: auto-fill the vessel_library table from vessels already in the DB.

Run from the backend/ directory:

    python -m scripts.autofill_vessel_library

It is idempotent — running it again only inserts vessels that aren't already in
the library (matched by IMO number, or normalized vessel name when no IMO).
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
    inserted = autofill_library(supabase)
    after = len(list_library(supabase))
    logger.info("Vessel library: %d existing → +%d inserted → %d total", before, inserted, after)


if __name__ == "__main__":
    main()
