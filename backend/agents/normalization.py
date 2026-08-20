"""
Agent 3 — Normalization
Scans every vessel's dynamic_data for a given email batch, builds a
superset of all unique keys, and fills missing keys with "" so the
validation grid has a uniform, predictable schema.
"""
import logging
from typing import Any

import pipeline_log as plog
from database import supabase
from sse_manager import sse_manager

logger = logging.getLogger(__name__)

# Keys that should always appear first in the grid (if present)
PRIORITY_KEYS = [
    "vessel_name",
    "dwt",
    "built",
    "imo",
    "flag",
    "region",
    "open_date",
    "laycan",
    "coating",
    "last_cargo",
    "space",
    "direction",
    "speed",
    "loa",
    "beam",
    "draft",
    "holds",
    "hatches",
    "cranes",
    "grain_cap",
    "bale_cap",
    "owner",
]


def _build_superset(vessels: list[dict]) -> list[str]:
    """Return an ordered list of all unique keys across all vessel rows."""
    seen: set[str] = set()
    all_keys: list[str] = []

    # Priority keys first (if any vessel uses them)
    all_vessel_keys: set[str] = set()
    for v in vessels:
        all_vessel_keys.update(v.get("dynamic_data", {}).keys())

    for key in PRIORITY_KEYS:
        if key in all_vessel_keys:
            seen.add(key)
            all_keys.append(key)

    # Then remaining keys in alphabetical order
    for key in sorted(all_vessel_keys - seen):
        all_keys.append(key)

    return all_keys


async def run_normalization(job_id: str, email_id: str) -> list[str]:
    """
    Builds the superset column list and back-fills missing keys with "".
    Does NOT mark the parent email ready — that happens after signature + contacts.
    Returns the ordered superset key list.
    """
    await sse_manager.send(job_id, "normalization_started", {
        "message": "Building superset column schema…",
    })

    with plog.step("Phase1", "Normalization", email_id=email_id[:8]):
        rows = (
            supabase.table("vessels_full")
            .select("id, dynamic_data")
            .eq("parent_email_id", email_id)
            .execute()
        )
        vessels = rows.data or []

        if not vessels:
            plog.warn("Phase1", "No vessels for normalization", email_id=email_id[:8])
            await sse_manager.send(job_id, "normalization_done", {
                "email_id": email_id,
                "column_count": 0,
                "vessel_count": 0,
                "columns": [],
            })
            return []

        superset = _build_superset(vessels)

        # Back-fill missing keys with "" for each vessel
        for vessel in vessels:
            original: dict = vessel.get("dynamic_data") or {}
            updated = {key: original.get(key, "") for key in superset}
            if updated != original:
                supabase.table("vessels").update({"dynamic_data": updated}).eq("id", vessel["id"]).execute()

        plog.info("Phase1", "Normalization done", email_id=email_id[:8], columns=len(superset), vessels=len(vessels))

    await sse_manager.send(job_id, "normalization_done", {
        "email_id": email_id,
        "column_count": len(superset),
        "vessel_count": len(vessels),
        "columns": superset,
    })

    return superset
