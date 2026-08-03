"""
Agent 1 — Ingestion
Connects to the broker mailbox, fetches every incoming broker email
(skipping automated senders), and — for each NEW email (unseen Message-ID) —
saves a parent_email + one attachment row (its body + files). Returns the IDs
for Agent 2. Already-processed emails are skipped (no re-billing of the LLM).
"""
import asyncio
import base64
import logging
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

from config import settings
from database import supabase
from imap_client import fetch_broker_emails
from sse_manager import sse_manager
from agents.contact_extract import clean_subject
from file_storage import save_bytes

logger = logging.getLogger(__name__)


def _save_files(att_id: str, files: list[dict]) -> list[dict]:
    """Persist each file (local disk or S3) and return JSON metadata."""
    if not files:
        return []
    meta: list[dict] = []
    for idx, f in enumerate(files):
        safe = (re.sub(r"[^A-Za-z0-9._-]", "_", f.get("filename", "")) or f"file_{idx}")[:120]
        stored = f"{idx}_{safe}"
        try:
            save_bytes(att_id, stored, f["content"])
            meta.append({
                "idx": idx,
                "name": f.get("filename", stored),
                "content_type": f.get("content_type", "application/octet-stream"),
                "size": len(f["content"]),
                "stored": stored,
            })
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to save file %s for att %s: %s", safe, att_id, exc)
    return meta


def _build_preview_images(files: list[dict]) -> list[dict]:
    """Image attachments → [{name, data_url}] for the inline formatted preview."""
    out: list[dict] = []
    for f in files or []:
        ct = (f.get("content_type") or "").lower()
        name = f.get("filename") or ""
        is_img = ct.startswith("image/") or name.lower().endswith(
            (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
        )
        content = f.get("content")
        if not is_img or not content:
            continue
        media = ct if ct.startswith("image/") else "image/png"
        try:
            b64 = base64.standard_b64encode(content).decode("ascii")
        except Exception:  # noqa: BLE001
            continue
        out.append({"name": name, "data_url": f"data:{media};base64,{b64}"})
    return out


def _parse_date(raw: str) -> str:
    try:
        dt = parsedate_to_datetime(raw)
        if dt is not None:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.isoformat()
    except (TypeError, ValueError, IndexError):
        pass
    return datetime.now(timezone.utc).isoformat()


def _existing_message_ids(message_ids: list[str]) -> set[str]:
    """Return the subset of message_ids already present in parent_emails."""
    if not message_ids:
        return set()
    rows = (
        supabase.table("parent_emails")
        .select("message_id")
        .in_("message_id", message_ids)
        .execute()
    ).data or []
    return {r.get("message_id") for r in rows if r.get("message_id")}


async def run_ingestion(
    job_id: str,
    date_from: str | None = None,
    date_to: str | None = None,
    min_uid: int | None = None,
) -> dict[str, Any]:
    """
    Fetch broker emails (optionally date-filtered) and ingest only the NEW ones.

    min_uid: IDLE watermark — only IMAP UIDs greater than this (no history backfill).

    Returns:
        {
            "email_ids": [str, ...],       # parent_email ids created this run
            "attachment_ids": [str, ...],  # one per new email
            "attachment_count": int,
            "new_count": int,
            "total_found": int,
            "max_imap_uid": int,           # highest UID seen this fetch (0 if none)
        }
    """
    await sse_manager.send(job_id, "ingestion_started",
                           {"message": "Connecting to mailbox…",
                            "date_from": date_from or None,
                            "date_to": date_to or None,
                            "min_uid": min_uid})

    # Run the blocking IMAP call in a thread so we don't block the event loop
    all_emails = await asyncio.to_thread(
        fetch_broker_emails,
        date_from,
        date_to,
        min_uid,
    )
    total_found = len(all_emails)
    max_imap_uid = max((int(e.get("imap_uid") or 0) for e in all_emails), default=0)

    # ── Only-new: drop emails whose Message-ID already exists ────────────
    seen = _existing_message_ids([e["message_id"] for e in all_emails])
    new_emails = [e for e in all_emails if e["message_id"] not in seen]

    # Deterministic order (oldest first) so cards read naturally, then cap.
    new_emails.reverse()
    limit = settings.MAX_ATTACHMENTS
    if limit and limit > 0 and len(new_emails) > limit:
        logger.info("Capping to %d of %d new emails (MAX_ATTACHMENTS=%d)",
                    limit, len(new_emails), limit)
        new_emails = new_emails[:limit]

    logger.info("Ingestion: %d total, %d already processed, %d new to ingest",
                total_found, len(seen), len(new_emails))

    email_ids: list[str] = []
    attachment_ids: list[str] = []

    for em in new_emails:
        subject = clean_subject(em.get("subject") or "")
        inserted = (
            supabase.table("parent_emails")
            .insert({
                "subject": subject,
                "sender": em["sender"],
                "date_received": _parse_date(em.get("date", "")),
                "status": "extracting",
                "message_id": em["message_id"],
            })
            .execute()
        )
        email_id: str = inserted.data[0]["id"]
        email_ids.append(email_id)

        await sse_manager.send(job_id, "email_saved", {
            "email_id": email_id,
            "subject": subject,
            "sender": em.get("sender") or "",
            "date_received": em.get("date") or "",
        })

        # Original message body, for the formatted (Outlook-style) preview pane.
        preview_html = em.get("html") or None
        preview_plain = em.get("raw_text") or None
        preview_images = _build_preview_images(em.get("files", []))

        # One attachment per broker email = its body + files.
        result = (
            supabase.table("attachments")
            .insert({
                "parent_email_id": email_id,
                "filename": em["filename"],
                "raw_text": em["raw_text"],
                "mail_from": em.get("sender", ""),
                "mail_subject": em.get("subject", ""),
                "mail_date": em.get("date", ""),
                "preview_html": preview_html,
                "preview_plain": preview_plain,
                "preview_images": preview_images or None,
                "status": "pending",
            })
            .execute()
        )
        att_id: str = result.data[0]["id"]
        attachment_ids.append(att_id)

        # Persist real file attachments (images / PDF / xlsx / docx) to disk.
        file_meta = _save_files(att_id, em.get("files", []))
        if file_meta:
            supabase.table("attachments").update({"files": file_meta}).eq("id", att_id).execute()

        await sse_manager.send(job_id, "attachment_saved", {
            "email_id": email_id,
            "attachment_id": att_id,
            "filename": em["filename"],
        })

    await sse_manager.send(job_id, "ingestion_summary", {
        "total_found": total_found,
        "already_processed": len(seen),
        "new_count": len(email_ids),
        "email_ids": email_ids,
        "attachment_ids": attachment_ids,
    })

    return {
        "email_ids": email_ids,
        "attachment_ids": attachment_ids,
        "attachment_count": len(attachment_ids),
        "new_count": len(new_emails),
        "total_found": total_found,
        "max_imap_uid": max_imap_uid,
    }
