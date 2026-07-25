"""
Attachment verification — gates which vessels appear on Vessel Position List.
High-confidence attachments (tier high, ≤5 empty applicable columns) are auto-verified.
"""
from __future__ import annotations

import logging
from typing import Any

from agents.confidence_score import attachment_needs_review, compute_attachment_confidence

logger = logging.getLogger(__name__)


def _vessel_count(supabase, attachment_id: str) -> int:
    rows = (
        supabase.table("vessels")
        .select("id")
        .eq("attachment_id", attachment_id)
        .execute()
    )
    return len(rows.data or [])


def _get_attachment(supabase, attachment_id: str) -> dict[str, Any] | None:
    rows = (
        supabase.table("attachments")
        .select("id, status, is_verified, parent_email_id")
        .eq("id", attachment_id)
        .limit(1)
        .execute()
    )
    data = rows.data or []
    return data[0] if data else None


def can_verify_attachment(att: dict[str, Any], vessel_count: int) -> bool:
    return att.get("status") == "done" and vessel_count >= 1


def set_attachment_verified(supabase, attachment_id: str, verified: bool) -> dict[str, Any]:
    att = _get_attachment(supabase, attachment_id)
    if not att:
        raise ValueError("Attachment not found.")

    count = _vessel_count(supabase, attachment_id)
    if verified and not can_verify_attachment(att, count):
        raise ValueError("Cannot verify: attachment must be downloaded with at least one vessel.")

    supabase.table("attachments").update({"is_verified": verified}).eq("id", attachment_id).execute()
    supabase.table("vessels").update({"is_validated": verified}).eq("attachment_id", attachment_id).execute()

    return {
        "attachment_id": attachment_id,
        "is_verified": verified,
        "vessel_count": count,
    }


def is_attachment_verified(supabase, attachment_id: str) -> bool:
    att = _get_attachment(supabase, attachment_id)
    return bool(att and att.get("is_verified"))


def assert_attachment_editable(supabase, vessel_id: str) -> None:
    """Ensure the vessel exists. Verified attachments may be edited; callers
    should un-verify after a successful save with real changes (UI flow)."""
    rows = (
        supabase.table("vessels")
        .select("attachment_id")
        .eq("id", vessel_id)
        .limit(1)
        .execute()
    )
    if not rows.data:
        raise ValueError("Vessel not found.")


def _eligible_attachment_ids(supabase, parent_email_id: str | None = None) -> list[str]:
    q = supabase.table("attachments").select("id, status, is_verified")
    if parent_email_id:
        q = q.eq("parent_email_id", parent_email_id)
    rows = q.execute()
    eligible: list[str] = []
    for att in rows.data or []:
        if att.get("is_verified"):
            continue
        if att.get("status") != "done":
            continue
        if _vessel_count(supabase, att["id"]) < 1:
            continue
        eligible.append(att["id"])
    return eligible


def verify_all_eligible(supabase, parent_email_id: str | None = None) -> dict[str, Any]:
    ids = _eligible_attachment_ids(supabase, parent_email_id)
    for att_id in ids:
        set_attachment_verified(supabase, att_id, True)
    return {"verified_count": len(ids), "attachment_ids": ids}


def _fetch_vessels(supabase, attachment_id: str) -> list[dict[str, Any]]:
    rows = (
        supabase.table("vessels")
        .select("region, dynamic_data")
        .eq("attachment_id", attachment_id)
        .execute()
    )
    return rows.data or []


def _attachment_confidence(supabase, att: dict[str, Any]) -> dict[str, Any]:
    vessels = _fetch_vessels(supabase, att["id"])
    return compute_attachment_confidence(
        status=att.get("status") or "",
        vessel_count=len(vessels),
        vessels=vessels,
        raw_text=None,
        manually_reviewed=bool(att.get("manually_reviewed")),
        columns_in_email=att.get("columns_in_email"),
    )


def should_auto_verify(supabase, attachment_id: str) -> bool:
    """True when attachment qualifies for auto-verify (high tier, not needing review)."""
    rows = (
        supabase.table("attachments")
        .select("id, status, is_verified, manually_reviewed, columns_in_email")
        .eq("id", attachment_id)
        .limit(1)
        .execute()
    )
    data = rows.data or []
    if not data:
        return False
    att = data[0]
    if att.get("is_verified"):
        return False
    if not can_verify_attachment(att, _vessel_count(supabase, attachment_id)):
        return False
    conf = _attachment_confidence(supabase, att)
    if attachment_needs_review(
        status=att.get("status") or "",
        confidence_tier=conf.get("confidence_tier"),
        max_unfilled=conf.get("max_unfilled", 0),
    ):
        return False
    return conf.get("confidence_tier") == "high"


def try_auto_verify_attachment(supabase, attachment_id: str) -> bool:
    """Auto-verify when eligible. Returns True if newly verified."""
    if not should_auto_verify(supabase, attachment_id):
        return False
    set_attachment_verified(supabase, attachment_id, True)
    logger.info("[Verify] Auto-verified attachment %s (high confidence)", attachment_id)
    return True


def backfill_auto_verify(supabase) -> int:
    """Verify all done, unverified attachments that meet high-confidence rules."""
    rows = (
        supabase.table("attachments")
        .select("id")
        .eq("status", "done")
        .eq("is_verified", False)
        .execute()
    )
    count = 0
    for att in rows.data or []:
        if try_auto_verify_attachment(supabase, att["id"]):
            count += 1
    return count
