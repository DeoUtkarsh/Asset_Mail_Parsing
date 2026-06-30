"""
Agent 3 — Normalization
Ensures every vessel row uses only the standard dynamic_data keys.
"""
import logging

from column_defs import STANDARD_DYNAMIC_KEYS, map_raw_to_standard
from database import supabase
from sse_manager import sse_manager

logger = logging.getLogger(__name__)


async def run_normalization(job_id: str, email_id: str) -> list[str]:
    """
    Standardizes dynamic_data to the fixed column schema and updates parent email status.
    Returns the list of dynamic_data keys.
    """
    await sse_manager.send(job_id, "normalization_started", {
        "message": "Standardizing vessel columns…",
    })

    rows = (
        supabase.table("vessels_full")
        .select("id, dynamic_data, region")
        .eq("parent_email_id", email_id)
        .execute()
    )
    vessels = rows.data or []

    if not vessels:
        logger.warning("No vessels found for email_id=%s during normalization.", email_id)
        supabase.table("parent_emails").update({"status": "ready_for_validation"}).eq("id", email_id).execute()
        return list(STANDARD_DYNAMIC_KEYS)

    for vessel in vessels:
        standardized, region = map_raw_to_standard(
            vessel.get("dynamic_data") or {},
            vessel.get("region"),
        )
        supabase.table("vessels").update({
            "dynamic_data": standardized,
            "region": region,
        }).eq("id", vessel["id"]).execute()

    supabase.table("parent_emails").update({"status": "ready_for_validation"}).eq("id", email_id).execute()

    await sse_manager.send(job_id, "normalization_done", {
        "email_id": email_id,
        "column_count": len(STANDARD_DYNAMIC_KEYS),
        "vessel_count": len(vessels),
        "columns": list(STANDARD_DYNAMIC_KEYS),
    })

    return list(STANDARD_DYNAMIC_KEYS)
