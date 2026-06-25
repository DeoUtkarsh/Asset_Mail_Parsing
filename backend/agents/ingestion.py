"""
Agent 1 — Ingestion
Connects to Gmail, finds the target email, saves parent_email +
attachment rows to Supabase, and returns the IDs for Agent 2.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from config import settings
from database import supabase
from imap_client import fetch_new_target_email
from sse_manager import sse_manager

logger = logging.getLogger(__name__)


def _stored_message_ids() -> set[str]:
    rows = supabase.table("parent_emails").select("message_id").execute()
    return {
        (row.get("message_id") or "").strip()
        for row in (rows.data or [])
        if row.get("message_id")
    }


async def run_ingestion(job_id: str) -> dict[str, Any]:
    """
    Returns:
        {
            "email_id": str,
            "attachment_ids": [str, ...],
            "attachment_count": int,
        }
    Raises nothing when no new email is found (returns empty ids).
    """
    await sse_manager.send(job_id, "ingestion_started", {"message": "Connecting to Gmail…"})

    skip_ids = _stored_message_ids()
    email_data = await asyncio.to_thread(fetch_new_target_email, skip_ids)

    if email_data is None:
        await sse_manager.send(job_id, "ingestion_skipped", {
            "message": "No new forwarded emails to fetch. Matching mails are already in the database.",
        })
        return {
            "email_id": "",
            "attachment_ids": [],
            "attachment_count": 0,
        }

    # ── Insert new parent_email (never re-process existing message_id) ───
    try:
        date_received = datetime.strptime(
            email_data["date"], "%a, %d %b %Y %H:%M:%S %z"
        ).isoformat()
    except (ValueError, TypeError):
        date_received = datetime.now(timezone.utc).isoformat()

    inserted = (
        supabase.table("parent_emails")
        .insert({
            "subject": email_data["subject"],
            "sender": email_data["sender"],
            "date_received": date_received,
            "status": "extracting",
            "message_id": email_data["message_id"],
        })
        .execute()
    )
    email_id: str = inserted.data[0]["id"]

    # ── Apply attachment limit ────────────────────────────────────────────
    all_attachments = email_data["attachments"]
    limit = settings.MAX_ATTACHMENTS
    if limit and limit > 0:
        attachments_to_process = all_attachments[:limit]
        if len(all_attachments) > limit:
            logger.info(
                "Limiting to %d of %d attachments (MAX_ATTACHMENTS=%d)",
                limit, len(all_attachments), limit,
            )
    else:
        attachments_to_process = all_attachments

    await sse_manager.send(job_id, "email_saved", {
        "email_id": email_id,
        "attachment_count": len(attachments_to_process),
        "total_found": len(all_attachments),
        "message": f"Processing {len(attachments_to_process)} of {len(all_attachments)} .eml attachments.",
    })

    # ── Insert attachment rows ────────────────────────────────────────────
    attachment_ids: list[str] = []
    for att in attachments_to_process:
        result = (
            supabase.table("attachments")
            .insert({
                "parent_email_id": email_id,
                "filename": att["filename"],
                "raw_text": att["raw_text"],
                "status": "pending",
            })
            .execute()
        )
        att_id: str = result.data[0]["id"]
        attachment_ids.append(att_id)

        await sse_manager.send(job_id, "attachment_saved", {
            "email_id": email_id,
            "attachment_id": att_id,
            "filename": att["filename"],
        })

    return {
        "email_id": email_id,
        "attachment_ids": attachment_ids,
        "attachment_count": len(attachment_ids),
    }
