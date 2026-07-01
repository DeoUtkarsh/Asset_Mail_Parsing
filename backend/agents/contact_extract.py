"""
Extract structured broker contact rows from attachment email text (signature / contact blocks).
Used by the live fetch pipeline, retry paths, and optional audit scripts.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from openai import AsyncOpenAI, RateLimitError

from config import settings
from database import supabase
from sse_manager import sse_manager
from agents.signature_extract import (
    _merge_signature_strings,
    preprocess_for_signature,
    regex_fallback_signature,
)

logger = logging.getLogger(__name__)

nvidia_client = AsyncOpenAI(
    base_url=settings.NVIDIA_API_BASE_URL,
    api_key=settings.NVIDIA_API_KEY,
    max_retries=0,
)

CONTACT_FIELD_KEYS = [
    "contact_name",
    "designation",
    "department",
    "company",
    "company_type",
    "vessel_name",
    "email",
    "off_phone",
    "mob_phone",
    "wechat",
    "whatsapp",
    "website_address",
    "office_address",
    "other_info",
    "status",
]

CONTACT_EXTRACT_PROMPT = """\
You extract BROKER / CHARTERING CONTACT records from the tail of a shipbroking email (.eml body).

Rules:
1. Focus on signature blocks, company letterheads, and contact lines (Tel, Mobile, Email, WeChat, WhatsApp, website, address).
2. For fleet position lists dominated by vessel tables, still extract signature / contact blocks at the end (names, Tel, Mobile, Email lines).
3. Ignore vessel specification tables (DWT, IMO, ETA FOC lists) unless needed for vessel_name on a single-vessel note.
4. Return ONLY valid JSON with one key "contacts" whose value is an array of objects.
5. Each object uses EXACTLY these keys (use "" if unknown — do not invent):
   - contact_name, designation, department, company, company_type, vessel_name
   - email, off_phone, mob_phone, wechat, whatsapp
   - website_address, office_address, other_info, status
6. email: one primary email per contact row (lowercase). If multiple people share one block, create multiple rows.
7. off_phone: office / direct / tel / DID lines. mob_phone: mobile / cell / handphone.
8. company_type: e.g. "Owner", "Charterer", "Broker", "Operator" if stated; else "".
9. vessel_name: only if clearly tied to this contact row or single-vessel position; else "".
10. status: use "Active" if contact looks current, else "".
11. Do not include GDPR footers, Proofpoint links, or unsubscribe text.

Attachment filename hint: {filename_hint}

TEXT (tail of message):
{chunk}

JSON OUTPUT ONLY:"""


def _is_retryable_llm_error(exc: Exception) -> bool:
    if isinstance(exc, RateLimitError):
        return True
    msg = str(exc).lower()
    return any(
        token in msg
        for token in ("429", "503", "rate limit", "too many requests", "resourceexhausted")
    )


def _retry_delay_seconds(exc: Exception, attempt: int) -> float:
    if _is_retryable_llm_error(exc):
        base = settings.EXTRACTION_RATE_LIMIT_BASE_SEC
        return min(base * (2 ** (attempt - 1)), 120.0)
    return min(2.0 ** attempt, 30.0)


def _empty_contact() -> dict[str, str]:
    return {k: "" for k in CONTACT_FIELD_KEYS}


def _normalize_contact(obj: dict[str, Any]) -> dict[str, str]:
    out = _empty_contact()
    if not isinstance(obj, dict):
        return out
    for k in CONTACT_FIELD_KEYS:
        val = obj.get(k)
        if val is None:
            continue
        out[k] = str(val).strip()
    return out


def _parse_contact_json(text: str) -> list[dict[str, str]]:
    text = re.sub(r"```(?:json)?\s*", "", text)
    text = re.sub(r"```\s*$", "", text, flags=re.MULTILINE).strip()
    raw_obj: Any = None
    try:
        raw_obj = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            try:
                raw_obj = json.loads(m.group())
            except json.JSONDecodeError:
                pass
    if not isinstance(raw_obj, dict):
        return []
    contacts = raw_obj.get("contacts")
    if not isinstance(contacts, list):
        return []
    rows = [_normalize_contact(c) for c in contacts if isinstance(c, dict)]
    return [r for r in rows if any(r.values())]


FALLBACK_OTHER_INFO = "signature fallback"


def _company_hint_from_filename(filename: str) -> str:
    name = re.sub(r"\.eml$", "", (filename or "").strip(), flags=re.I)
    name = re.sub(
        r"\s*[-–]\s*(POSITION|POSITIONS|OPEN|WEEK|WW|GLOBAL|FLEET|VESSEL|TONNAGE).*$",
        "",
        name,
        flags=re.I,
    )
    return name.strip()


def _split_semicolon_field(value: str) -> list[str]:
    return [p.strip() for p in re.split(r"\s*;\s*", (value or "").strip()) if p.strip()]


def contacts_from_signature_strings(
    emails_str: str,
    phones_str: str,
    *,
    company_hint: str = "",
) -> list[dict[str, str]]:
    """Build sparse contact rows from merged signature email/phone strings."""
    emails = [e.lower() for e in _split_semicolon_field(emails_str)]
    phones = _split_semicolon_field(phones_str)
    rows: list[dict[str, str]] = []

    if emails:
        for email in emails:
            row = _empty_contact()
            row["email"] = email
            if company_hint:
                row["company"] = company_hint
            row["status"] = "Active"
            row["other_info"] = FALLBACK_OTHER_INFO
            rows.append(row)
        for i, phone in enumerate(phones):
            target = rows[i % len(rows)]
            slot = "mob_phone" if not target["mob_phone"] else "off_phone"
            if target[slot]:
                target[slot] = f"{target[slot]} ; {phone}"
            else:
                target[slot] = phone
    elif phones:
        for phone in phones:
            row = _empty_contact()
            row["mob_phone"] = phone
            if company_hint:
                row["company"] = company_hint
            row["status"] = "Active"
            row["other_info"] = FALLBACK_OTHER_INFO
            rows.append(row)

    return rows


def signature_fallback_contacts(
    chunk: str,
    *,
    filename: str = "",
    signature_emails: str = "",
    signature_phones: str = "",
) -> list[dict[str, str]]:
    """Regex + DB signature strings → sparse contact rows when LLM returns nothing."""
    fb = regex_fallback_signature(chunk)
    emails = _merge_signature_strings(signature_emails or "", fb.get("emails") or "", is_email=True)
    phones = _merge_signature_strings(signature_phones or "", fb.get("phones") or "", is_email=False)
    if not emails and not phones:
        return []
    return contacts_from_signature_strings(
        emails,
        phones,
        company_hint=_company_hint_from_filename(filename),
    )


async def llm_extract_contacts(chunk: str, filename_hint: str = "") -> list[dict[str, str]]:
    if not chunk or len(chunk) < 30:
        return []

    max_attempts = settings.EXTRACTION_MAX_ATTEMPTS
    last_error = ""

    for attempt in range(1, max_attempts + 1):
        try:
            resp = await nvidia_client.chat.completions.create(
                model=settings.NVIDIA_LLM_MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You extract structured broker contact rows from email signatures. "
                            "Output only valid JSON."
                        ),
                    },
                    {
                        "role": "user",
                        "content": CONTACT_EXTRACT_PROMPT.format(
                            chunk=chunk[:14000],
                            filename_hint=filename_hint or "(unknown)",
                        ),
                    },
                ],
                temperature=0.1,
                max_tokens=2048,
            )
            content = resp.choices[0].message.content or ""
            return _parse_contact_json(content)
        except Exception as exc:
            last_error = str(exc)
            if attempt < max_attempts and _is_retryable_llm_error(exc):
                delay = _retry_delay_seconds(exc, attempt)
                logger.warning(
                    "[ContactExtract] %s attempt %d/%d failed (%s); retry in %.1fs",
                    filename_hint,
                    attempt,
                    max_attempts,
                    exc,
                    delay,
                )
                await asyncio.sleep(delay)
                continue
            logger.warning("[ContactExtract] LLM failed for %s: %s", filename_hint, exc)
            break

    if last_error:
        raise RuntimeError(last_error)
    return []


async def extract_contacts_from_attachment(
    raw_text: str,
    *,
    filename: str = "",
    signature_emails: str = "",
    signature_phones: str = "",
    fallback_only: bool = False,
) -> list[dict[str, str]]:
    """Preprocess tail + LLM → contact dicts; regex/DB fallback if LLM returns nothing."""
    chunk = preprocess_for_signature(raw_text or "")
    if not fallback_only:
        try:
            contacts = await llm_extract_contacts(chunk, filename_hint=filename)
        except Exception:
            contacts = []
        if contacts:
            return contacts
    return signature_fallback_contacts(
        chunk,
        filename=filename,
        signature_emails=signature_emails,
        signature_phones=signature_phones,
    )


def contacts_used_fallback(contacts: list[dict[str, str]]) -> bool:
    return bool(contacts) and all(
        (c.get("other_info") or "") == FALLBACK_OTHER_INFO for c in contacts
    )


def summarize_vessel_names(names: list[str], max_show: int = 3) -> str:
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    if len(names) <= max_show:
        return "; ".join(names)
    extra = len(names) - max_show
    return "; ".join(names[:max_show]) + f" (+{extra} more)"


def vessel_names_for_attachment(attachment_id: str) -> list[str]:
    """Vessel names already extracted for this attachment (Position List)."""
    rows = (
        supabase.table("vessels")
        .select("dynamic_data")
        .eq("attachment_id", attachment_id)
        .execute()
    ).data or []
    names: list[str] = []
    seen: set[str] = set()
    for row in rows:
        name = ((row.get("dynamic_data") or {}).get("vessel_name") or "").strip()
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            names.append(name)
    return names


def enrich_contacts_vessel_names(
    attachment_id: str,
    contacts: list[dict[str, str]],
) -> list[dict[str, str]]:
    """
    Fill empty contact vessel_name from vessels table on the same attachment.
    Single vessel → exact name; multiple → short summary (e.g. 'A; B; C (+5 more)').
    """
    if not contacts:
        return contacts
    names = vessel_names_for_attachment(attachment_id)
    if not names:
        return contacts
    summary = summarize_vessel_names(names)
    enriched: list[dict[str, str]] = []
    for contact in contacts:
        row = dict(contact)
        if not (row.get("vessel_name") or "").strip():
            row["vessel_name"] = summary
        enriched.append(row)
    return enriched


def _contact_row_db_payload(
    attachment_id: str,
    parent_email_id: str | None,
    contact: dict[str, str],
    row_order: int,
    used_fallback: bool,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "attachment_id": attachment_id,
        "parent_email_id": parent_email_id,
        "row_order": row_order,
        "used_fallback": used_fallback
        or (contact.get("other_info") or "") == FALLBACK_OTHER_INFO,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    for key in CONTACT_FIELD_KEYS:
        row[key] = (contact.get(key) or "").strip()
    return row


def save_broker_contacts_for_attachment(
    attachment_id: str,
    parent_email_id: str | None,
    contacts: list[dict[str, str]],
    *,
    used_fallback: bool | None = None,
) -> int:
    """Replace broker_contacts for one attachment. Returns rows inserted."""
    contacts = enrich_contacts_vessel_names(attachment_id, contacts)
    supabase.table("broker_contacts").delete().eq("attachment_id", attachment_id).execute()
    if not contacts:
        return 0
    fb = contacts_used_fallback(contacts) if used_fallback is None else used_fallback
    for i, contact in enumerate(contacts):
        payload = _contact_row_db_payload(attachment_id, parent_email_id, contact, i, fb)
        supabase.table("broker_contacts").insert(payload).execute()
    return len(contacts)


async def _process_attachment_contacts(
    job_id: str,
    att: dict,
    parent_email_id: str,
) -> int:
    """Extract structured contacts for one attachment and persist to broker_contacts."""
    aid = att.get("id")
    filename = att.get("filename") or ""
    raw = att.get("raw_text") or ""

    await sse_manager.send(job_id, "contact_attachment_started", {
        "attachment_id": aid,
        "filename": filename,
    })

    if len(raw.strip()) < 30:
        save_broker_contacts_for_attachment(aid, parent_email_id, [])
        await sse_manager.send(job_id, "contact_attachment_done", {
            "attachment_id": aid,
            "filename": filename,
            "contact_count": 0,
        })
        return 0

    gap = max(2.0, settings.EXTRACTION_REQUEST_DELAY_SEC)
    await asyncio.sleep(gap)

    contacts = await extract_contacts_from_attachment(
        raw,
        filename=filename,
        signature_emails=att.get("signature_emails") or "",
        signature_phones=att.get("signature_phones") or "",
    )
    count = save_broker_contacts_for_attachment(aid, parent_email_id, contacts)

    await sse_manager.send(job_id, "contact_attachment_done", {
        "attachment_id": aid,
        "filename": filename,
        "contact_count": count,
        "used_fallback": contacts_used_fallback(contacts),
    })
    return count


async def run_attachment_contact_extraction(job_id: str, attachment_id: str) -> None:
    """Structured contact pass for a single attachment (per-row retry)."""
    row = (
        supabase.table("attachments")
        .select(
            "id, filename, raw_text, parent_email_id, signature_emails, signature_phones"
        )
        .eq("id", attachment_id)
        .execute()
    )
    if not row.data:
        return
    att = row.data[0]
    parent_email_id = att.get("parent_email_id") or ""
    try:
        await _process_attachment_contacts(job_id, att, parent_email_id)
    except Exception as exc:
        logger.exception("[ContactExtract] Failed attachment %s: %s", attachment_id, exc)
        await sse_manager.send(job_id, "contact_extraction_error", {
            "attachment_id": attachment_id,
            "error": str(exc),
        })


async def run_parent_contact_extraction(job_id: str, email_id: str) -> None:
    """
    For each attachment under this parent, extract structured broker contacts
    (LLM + signature fallback) and save to broker_contacts.
    Run after signature_emails/signature_phones are on attachment rows.
    """
    try:
        await _run_parent_contact_extraction_impl(job_id, email_id)
    except Exception as exc:
        logger.exception("[ContactExtract] Failed for parent %s: %s", email_id, exc)
        await sse_manager.send(job_id, "contact_extraction_error", {
            "email_id": email_id,
            "error": str(exc),
        })


async def _run_parent_contact_extraction_impl(job_id: str, email_id: str) -> None:
    await sse_manager.send(job_id, "contact_extraction_started", {
        "message": "Extracting structured broker contacts…",
    })

    rows = (
        supabase.table("attachments")
        .select(
            "id, filename, raw_text, status, signature_emails, signature_phones"
        )
        .eq("parent_email_id", email_id)
        .execute()
    )
    attachments = rows.data or []
    total_rows = 0
    updated = 0

    for att in attachments:
        if att.get("status") == "error":
            continue
        count = await _process_attachment_contacts(job_id, att, email_id)
        if count > 0:
            updated += 1
            total_rows += count

    logger.info(
        "[ContactExtract] parent=%s attachments_with_contacts=%d contact_rows=%d",
        email_id,
        updated,
        total_rows,
    )

    await sse_manager.send(job_id, "contact_extraction_done", {
        "email_id": email_id,
        "attachments_with_contacts": updated,
        "contact_row_count": total_rows,
    })
