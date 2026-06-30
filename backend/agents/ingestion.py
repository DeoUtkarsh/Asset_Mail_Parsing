"""
Agent 1 — Ingestion
Connects to Gmail, finds target emails, saves parent_email +
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


async def _persist_email(job_id: str, email_data: dict) -> dict[str, Any]:
    """Insert one parent email + attachment rows from IMAP payload."""
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
        "subject": email_data["subject"],
        "sender": email_data["sender"],
        "attachment_count": len(attachments_to_process),
        "total_found": len(all_attachments),
        "message": f"Processing {len(attachments_to_process)} of {len(all_attachments)} .eml attachments.",
    })

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
        "subject": email_data["subject"],
        "sender": email_data["sender"],
    }


async def run_batch_ingestion(job_id: str) -> list[dict[str, Any]]:
    """
    Fetch and persist every matching inbox email not yet in the database.
    Returns a list (newest first) of {email_id, attachment_ids, attachment_count, ...}.
    """
    await sse_manager.send(job_id, "ingestion_started", {
        "message": "Connecting to Gmail…",
    })

    skip_ids = _stored_message_ids()
    ingested: list[dict[str, Any]] = []

    while True:
        email_data = await asyncio.to_thread(fetch_new_target_email, skip_ids)
        if email_data is None:
            break

        result = await _persist_email(job_id, email_data)
        ingested.append(result)
        skip_ids.add(email_data["message_id"])
        logger.info(
            "Ingested parent email %d — %s (%d attachments)",
            len(ingested),
            email_data["subject"][:80],
            result["attachment_count"],
        )

    if not ingested:
        await sse_manager.send(job_id, "ingestion_skipped", {
            "message": "No new forwarded emails to fetch. Matching mails are already in the database.",
        })
    else:
        await sse_manager.send(job_id, "batch_ingestion_complete", {
            "emails_found": len(ingested),
            "total_attachments": sum(item["attachment_count"] for item in ingested),
            "message": f"Found {len(ingested)} new parent email(s). Starting extraction…",
        })

    return ingested


async def run_ingestion(job_id: str) -> dict[str, Any]:
    """
    Ingest a single new email (used by LangGraph workflow nodes).
    Returns empty ids when no new email is found.
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

    return await _persist_email(job_id, email_data)
