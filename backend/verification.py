"""
Attachment verification — gates which vessels appear on Vessel Position List.
"""
from __future__ import annotations

from typing import Any


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
    rows = (
        supabase.table("vessels")
        .select("attachment_id")
        .eq("id", vessel_id)
        .limit(1)
        .execute()
    )
    if not rows.data:
        raise ValueError("Vessel not found.")
    att_id = rows.data[0]["attachment_id"]
    if is_attachment_verified(supabase, att_id):
        raise ValueError("Attachment is verified. Un-verify to edit vessels.")


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
