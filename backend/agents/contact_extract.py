"""
Extract structured broker contact rows from attachment email text (signature / contact blocks).
Used by the live fetch pipeline and retry paths.

Pipeline:
  1) Claude extract (tight prompt — only facts present in the mail)
  2) Deterministic scrub / merge / signature-email prefer
  3) Claude column-remap — review draft vs email, place into required columns
  4) Final scrub / merge
  If LLM yields nothing → regex/signature fallback (used_fallback=True; never write
  "signature fallback" into other_info).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from anthropic import RateLimitError

from config import settings
from database import supabase
from sse_manager import sse_manager
from llm import claude_client
from agents.signature_extract import (
    _merge_signature_strings,
    preprocess_for_signature,
    regex_fallback_signature,
)

logger = logging.getLogger(__name__)

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

# Legacy marker only — never written into other_info going forward.
FALLBACK_OTHER_INFO = "signature fallback"

CONTACT_EXTRACT_PROMPT = """\
You extract BROKER / CHARTERING CONTACT records from the tail of a shipbroking email (.eml body).

Rules:
1. Focus on signature blocks, company letterheads, and contact lines
   (Tel, Mobile, Email, WeChat, WhatsApp, website, address).
2. For fleet position lists dominated by vessel tables, still extract signature /
   contact blocks (usually at the end).
3. Ignore vessel specification tables (DWT, IMO, ETA, FOC lists).
4. Return ONLY valid JSON with one key "contacts" (array of objects).
5. Each object uses EXACTLY these keys (use "" if unknown — NEVER invent):
   contact_name, designation, department, company, company_type, vessel_name,
   email, off_phone, mob_phone, wechat, whatsapp,
   website_address, office_address, other_info, status
6. PEOPLE vs SHARED BLOCKS:
   - If distinct people are named, create ONE ROW PER PERSON (even if they share a desk email).
     Never collapse multiple named people into a single row.
   - Shared company / chartering desk email (e.g. chartering@…) MUST still yield
     one row per named PIC — put the same email on each row.
   - If the SAME person lists multiple companies, put ALL companies in `company`
     as comma-separated values in ONE row — do NOT create one row per company.
   - Only if a shared signature has several emails and NO per-person names, create ONE row
     with all emails comma-separated in `email`.
7. email: lowercase. Prefer emails from the signature block over random body mentions.
8. off_phone = office / Tel / DID. mob_phone = Mobile / Cell / Handphone.
   Keep readable international format with leading + (e.g. +65 6781 3709). Never invent.
9. company: clean company / desk name only. Strip "Position List", dates, "Open Tonnage",
   "Week NN", vessel list titles. If several affiliates for one person → comma-separated.
10. company_type: ONLY if text has an explicit "Company type:" label. Otherwise "".
11. wechat / whatsapp: ONLY if a label like WeChat: / WhatsApp: appears. Otherwise "".
12. website_address: only real sites (www. / http / company domain lines). Else "".
13. designation = job title (Manager, Director…). department = desk (Chartering, Ops…).
    Do NOT put geographic region headers (ASIA, EUROPE, AMERICAS) into department.
14. other_info: Skype / ICE / leave notes only — NEVER write "signature fallback".
15. status: ONLY "Active" or "Inactive". Default "Active" if unclear. Never invent other labels.
16. Do not include GDPR footers, Proofpoint links, or unsubscribe text.
17. Extract EVERY named person in the signature — missing a named person is an error.

Attachment filename hint: {filename_hint}

TEXT (tail of message):
{chunk}

JSON OUTPUT ONLY:"""


COLUMN_REMAP_PROMPT = """\
You are a COLUMN-MAPPING reviewer for broker contact extraction.

You receive:
1) EMAIL_TEXT — the signature / contact tail of a shipbroking email
2) DRAFT_CONTACTS — JSON array already extracted (may have wrong columns, splits, or gaps)

Your job:
- Put every fact that EXISTS in EMAIL_TEXT into the correct column.
- If EMAIL_TEXT does not contain a fact, that column MUST be "".
- Do NOT invent company_type, WeChat, WhatsApp, designation, department, website, or phones.
- Do NOT invent contact names that are not in the email.
- Keep one row per distinct named person. Shared desk email may repeat on each row
  (do NOT collapse named PICs into one contact).
- Same person + multiple companies → one row, companies comma-separated.
- Several emails + no person names → one row, emails comma-separated.
- Clean company names (strip "Position List", dates, open tonnage titles).
- other_info: only Skype / ICE / leave notes from the email — never "signature fallback".
- status: ONLY "Active" or "Inactive" (default "Active").

Required keys on every object (use "" if unknown):
contact_name, designation, department, company, company_type, vessel_name,
email, off_phone, mob_phone, wechat, whatsapp,
website_address, office_address, other_info, status

Return ONLY valid JSON: {{"contacts": [ ... ]}}

EMAIL_TEXT:
{chunk}

DRAFT_CONTACTS:
{draft_json}

JSON OUTPUT ONLY:"""


_COMPANY_NOISE = re.compile(
    r"\s*[-–|/]\s*(?:east of suez\s+)?(?:position|positions|open(?:ing)?|"
    r"tonnage|fleet|vessel|week|ww|global|updated).*$",
    re.I,
)
_SUBJECT_PREFIX = re.compile(r"^\s*subject\s*:\s*", re.I)
_WECHAT_LABEL = re.compile(r"\bwe\s*-?\s*chat\b|\bwechat\b", re.I)
_WHATSAPP_LABEL = re.compile(r"\bwhats\s*-?\s*app\b|\bwa\b\s*[:：]", re.I)
_SCI_NOTATION = re.compile(r"^\s*\d+(?:\.\d+)?[eE][+-]?\d+\s*$")
_WEBSITE = re.compile(r"(?:https?://|www\.)[^\s<>\"']+", re.I)
_REGIONISH_DEPT = re.compile(
    r"^(?:asia|europe|americas|middle\s*east|far\s*east|usg|ara|med|"
    r"continent|india|indo|straits|sea|wci|eci)\b",
    re.I,
)


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


def clean_subject(subject: str) -> str:
    """Drop duplicated 'Subject:' prefix from stored / displayed subjects."""
    s = (subject or "").strip()
    while _SUBJECT_PREFIX.match(s):
        s = _SUBJECT_PREFIX.sub("", s, count=1).strip()
    return s


def _company_hint_from_filename(filename: str) -> str:
    name = re.sub(r"\.eml$", "", (filename or "").strip(), flags=re.I)
    name = re.sub(
        r"\s*[-–]\s*(POSITION|POSITIONS|OPEN|WEEK|WW|GLOBAL|FLEET|VESSEL|TONNAGE).*$",
        "",
        name,
        flags=re.I,
    )
    return name.strip()


def clean_company_name(company: str, filename_hint: str = "") -> str:
    raw = (company or "").strip()
    if not raw:
        raw = _company_hint_from_filename(filename_hint)
    if not raw:
        return ""
    parts = [p.strip() for p in re.split(r"\s*,\s*", raw) if p.strip()]
    cleaned: list[str] = []
    seen: set[str] = set()
    for part in parts:
        c = _COMPANY_NOISE.sub("", part).strip(" -–|/")
        c = re.sub(r"\s{2,}", " ", c).strip()
        key = c.lower()
        if c and key not in seen:
            seen.add(key)
            cleaned.append(c)
    return ", ".join(cleaned)


def format_phone(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    parts = [p.strip() for p in re.split(r"\s*[,;/|]\s*", raw) if p.strip()]
    out: list[str] = []
    for part in parts:
        if _SCI_NOTATION.match(part):
            try:
                part = str(int(float(part)))
            except ValueError:
                pass
        part = re.sub(r"\s+", " ", part).strip()
        out.append(part)
    return " ; ".join(out)


def _field_in_source(value: str, chunk: str) -> bool:
    v = (value or "").strip()
    if not v:
        return False
    return v.lower() in (chunk or "").lower()


def scrub_invented_fields(contact: dict[str, str], chunk: str) -> dict[str, str]:
    """Drop company_type / wechat / whatsapp unless evidenced in the mail."""
    row = dict(contact)

    ct = (row.get("company_type") or "").strip()
    if ct and not re.search(r"company\s*type\s*[:=]", chunk or "", re.I):
        row["company_type"] = ""

    for key, label_rx in (("wechat", _WECHAT_LABEL), ("whatsapp", _WHATSAPP_LABEL)):
        val = (row.get(key) or "").strip()
        if not val:
            continue
        if not label_rx.search(chunk or ""):
            row[key] = ""
        elif not _field_in_source(val, chunk):
            row[key] = ""

    dept = (row.get("department") or "").strip()
    if dept and _REGIONISH_DEPT.search(dept):
        row["department"] = ""

    if (row.get("other_info") or "").strip().lower() == FALLBACK_OTHER_INFO:
        row["other_info"] = ""

    row["company"] = clean_company_name(row.get("company") or "")
    row["off_phone"] = format_phone(row.get("off_phone") or "")
    row["mob_phone"] = format_phone(row.get("mob_phone") or "")
    row["email"] = ", ".join(
        sorted(
            {
                e.strip().lower()
                for e in re.split(r"\s*[,;]\s*", row.get("email") or "")
                if e.strip() and "@" in e
            }
        )
    )
    return row


def _merge_text_field(a: str, b: str, sep: str = ", ") -> str:
    items: list[str] = []
    seen: set[str] = set()
    for raw in (a, b):
        for part in re.split(rf"\s*{re.escape(sep.strip())}\s*|;|,", raw or ""):
            p = part.strip()
            if not p:
                continue
            key = p.lower()
            if key not in seen:
                seen.add(key)
                items.append(p)
    return sep.join(items)


def merge_contact_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    """
    Same contact_name → merge companies + emails into one row.
    Empty names → one shared row with comma-separated emails/companies.
    Distinct named people stay separate.
    """
    if not rows:
        return []

    buckets: dict[str, dict[str, str]] = {}
    order: list[str] = []

    for row in rows:
        name = (row.get("contact_name") or "").strip()
        key = name.lower() if name else "__unnamed__"
        if key not in buckets:
            buckets[key] = dict(row)
            order.append(key)
            continue
        base = buckets[key]
        for field in CONTACT_FIELD_KEYS:
            if field in ("company", "email"):
                base[field] = _merge_text_field(base.get(field) or "", row.get(field) or "")
            elif field in ("off_phone", "mob_phone"):
                base[field] = _merge_text_field(
                    base.get(field) or "", row.get(field) or "", sep=" ; "
                )
            elif field == "other_info":
                base[field] = _merge_text_field(
                    base.get(field) or "", row.get(field) or "", sep="; "
                )
            elif not (base.get(field) or "").strip() and (row.get(field) or "").strip():
                base[field] = row[field]
        buckets[key] = base

    return [buckets[k] for k in order]


def prefer_signature_emails(
    contacts: list[dict[str, str]],
    signature_emails: str,
) -> list[dict[str, str]]:
    """Signature emails first; backfill only when a single contact row."""
    sig = [
        e.strip().lower()
        for e in re.split(r"\s*;\s*", signature_emails or "")
        if e.strip() and "@" in e
    ]
    if not sig or not contacts:
        return contacts
    if len(contacts) != 1:
        return contacts

    existing = {
        e.strip().lower()
        for e in re.split(r"\s*[,;]\s*", contacts[0].get("email") or "")
        if e.strip()
    }
    missing = [e for e in sig if e not in existing]
    if not missing:
        return contacts

    out = [dict(c) for c in contacts]
    out[0]["email"] = _merge_text_field(out[0].get("email") or "", ", ".join(missing))
    return out


def ensure_website_from_chunk(contact: dict[str, str], chunk: str) -> dict[str, str]:
    row = dict(contact)
    if (row.get("website_address") or "").strip():
        return row
    m = _WEBSITE.search(chunk or "")
    if m:
        row["website_address"] = m.group(0).rstrip(".,);]")
    return row


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
            rows.append(row)

    return merge_contact_rows(rows)


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
    rows = contacts_from_signature_strings(
        emails,
        phones,
        company_hint=_company_hint_from_filename(filename),
    )
    cleaned: list[dict[str, str]] = []
    for row in rows:
        row = dict(row)
        row["other_info"] = ""
        row["company"] = clean_company_name(row.get("company") or "", filename)
        row["off_phone"] = format_phone(row.get("off_phone") or "")
        row["mob_phone"] = format_phone(row.get("mob_phone") or "")
        cleaned.append(row)
    return merge_contact_rows(cleaned)


async def llm_extract_contacts(chunk: str, filename_hint: str = "") -> list[dict[str, str]]:
    if not chunk or len(chunk) < 30:
        return []

    max_attempts = settings.EXTRACTION_MAX_ATTEMPTS
    last_error = ""

    for attempt in range(1, max_attempts + 1):
        try:
            resp = await claude_client.chat.completions.create(
                model=settings.CLAUDE_MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You extract structured broker contact rows from email signatures. "
                            "Never invent company_type, WeChat, or WhatsApp. Output only valid JSON."
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


async def llm_remap_contacts_to_columns(
    chunk: str,
    draft_contacts: list[dict[str, str]],
    *,
    filename_hint: str = "",
) -> list[dict[str, str]]:
    """Second Claude pass: map draft fields into required columns; never invent."""
    if not chunk or len(chunk) < 30:
        return draft_contacts

    draft_json = json.dumps(draft_contacts or [], ensure_ascii=False, indent=2)
    max_attempts = settings.EXTRACTION_MAX_ATTEMPTS

    for attempt in range(1, max_attempts + 1):
        try:
            resp = await claude_client.chat.completions.create(
                model=settings.CLAUDE_MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You remap extracted broker contact fields into the correct columns. "
                            "Use only facts present in the email. Never invent. Output only valid JSON."
                        ),
                    },
                    {
                        "role": "user",
                        "content": COLUMN_REMAP_PROMPT.format(
                            chunk=chunk[:12000],
                            draft_json=draft_json[:8000],
                        )
                        + (
                            f"\n\nAttachment filename hint: {filename_hint}"
                            if filename_hint
                            else ""
                        ),
                    },
                ],
                temperature=0.0,
                max_tokens=2500,
            )
            content = resp.choices[0].message.content or ""
            remapped = _parse_contact_json(content)
            return remapped if remapped else draft_contacts
        except Exception as exc:
            if attempt < max_attempts and _is_retryable_llm_error(exc):
                delay = _retry_delay_seconds(exc, attempt)
                logger.warning(
                    "[ContactRemap] %s attempt %d/%d failed (%s); retry in %.1fs",
                    filename_hint,
                    attempt,
                    max_attempts,
                    exc,
                    delay,
                )
                await asyncio.sleep(delay)
                continue
            logger.warning(
                "[ContactRemap] Soft-fail for %s (%s) — keeping draft",
                filename_hint,
                exc,
            )
            break

    return draft_contacts


async def extract_contacts_from_attachment(
    raw_text: str,
    *,
    filename: str = "",
    signature_emails: str = "",
    signature_phones: str = "",
    fallback_only: bool = False,
) -> tuple[list[dict[str, str]], bool]:
    """
    Preprocess + LLM extract + column remap; regex/DB fallback if LLM returns nothing.
    Returns (contacts, used_fallback).
    """
    chunk = preprocess_for_signature(raw_text or "")
    used_fallback = False
    contacts: list[dict[str, str]] = []

    if not fallback_only:
        try:
            contacts = await llm_extract_contacts(chunk, filename_hint=filename)
        except Exception:
            contacts = []

    if not contacts:
        used_fallback = True
        contacts = signature_fallback_contacts(
            chunk,
            filename=filename,
            signature_emails=signature_emails,
            signature_phones=signature_phones,
        )
    else:
        contacts = [scrub_invented_fields(c, chunk) for c in contacts]
        contacts = prefer_signature_emails(contacts, signature_emails)
        contacts = [ensure_website_from_chunk(c, chunk) for c in contacts]
        contacts = merge_contact_rows(contacts)

    if contacts:
        remapped = await llm_remap_contacts_to_columns(
            chunk, contacts, filename_hint=filename
        )
        if remapped:
            contacts = remapped
        contacts = [scrub_invented_fields(c, chunk) for c in contacts]
        contacts = prefer_signature_emails(contacts, signature_emails)
        contacts = merge_contact_rows(contacts)
        contacts = [scrub_invented_fields(c, chunk) for c in contacts]

    contacts = [
        c for c in contacts if any((c.get(k) or "").strip() for k in CONTACT_FIELD_KEYS)
    ]
    return contacts, used_fallback


def contacts_used_fallback(contacts: list[dict[str, str]]) -> bool:
    """Legacy detection via other_info marker (old rows only)."""
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


_EMPTY_CONTACT = frozenset({
    "", "-", "—", "–", ".", "..", "n/a", "na", "none", "null", "unknown",
})


def normalize_contact_status(val: Any) -> str:
    """Canonical contact status: Active (default) or Inactive."""
    s = str(val or "").strip().lower().replace("_", " ").replace("-", " ")
    s = re.sub(r"\s+", " ", s)
    if s in {"inactive", "in active", "disabled", "archived"}:
        return "Inactive"
    return "Active"


def _clean_contact_val(val: Any) -> str:
    s = str(val or "").strip()
    return "" if s.lower() in _EMPTY_CONTACT else s


def _first_email(raw: str) -> str:
    text = _clean_contact_val(raw).lower()
    if not text:
        return ""
    # Prefer first well-formed address in a comma/semicolon list
    for part in re.split(r"[,;\s]+", text):
        part = part.strip().strip("<>")
        if "@" in part and "." in part.split("@")[-1]:
            return part
    if "@" in text:
        return text.split(",")[0].strip()
    return ""


def _norm_phone(raw: str) -> str:
    digits = re.sub(r"\D", "", _clean_contact_val(raw))
    if len(digits) < 7:
        return ""
    # Drop leading country trunk zeros; keep full international digit string
    return digits.lstrip("0") or digits


def _norm_person_token(raw: str) -> str:
    s = _clean_contact_val(raw).upper()
    s = re.sub(r"[^A-Z0-9 ]+", "", s)
    return re.sub(r"\s+", " ", s).strip()


def contact_match_key(contact: dict[str, Any]) -> str:
    """Stable identity for upsert / dedupe.

    Named people sharing a desk email must stay separate rows. Order:
      1) name + email (when both present)
      2) name + phone
      3) name + company (or name alone)
      4) email alone (unnamed / desk-only rows)
      5) phone alone
    """
    name = _norm_person_token(str(contact.get("contact_name") or ""))
    email = _first_email(str(contact.get("email") or ""))
    phone = _norm_phone(str(contact.get("mob_phone") or "")) or _norm_phone(
        str(contact.get("off_phone") or "")
    )
    company = _norm_person_token(str(contact.get("company") or ""))

    if name:
        if email:
            return f"name:{name}|email:{email}"
        if phone:
            return f"name:{name}|phone:{phone}"
        if company:
            return f"name:{name}|company:{company}"
        return f"name:{name}"
    if email:
        return f"email:{email}"
    if phone:
        return f"phone:{phone}"
    return ""


def _merge_contact_fields(
    base: dict[str, Any],
    incoming: dict[str, Any],
) -> dict[str, str]:
    """Non-empty incoming contact fields overwrite base.

    Never overwrite a non-empty contact_name with a different person name —
    shared desk emails must not collapse distinct people.
    """
    out: dict[str, str] = {}
    for key in CONTACT_FIELD_KEYS:
        cur = _clean_contact_val(base.get(key))
        nxt = _clean_contact_val(incoming.get(key))
        if key == "other_info" and nxt.lower() == FALLBACK_OTHER_INFO:
            nxt = ""
        if key == "status":
            base_st = normalize_contact_status(cur) if cur else ""
            inc_st = normalize_contact_status(nxt) if nxt else ""
            # Keep Inactive once set — extraction should not flip it back to Active
            if base_st == "Inactive" and inc_st != "Inactive":
                out[key] = "Inactive"
            elif inc_st:
                out[key] = inc_st
            else:
                out[key] = base_st or "Active"
            continue
        if key == "contact_name" and cur and nxt:
            if _norm_person_token(cur) != _norm_person_token(nxt):
                out[key] = cur
                continue
        out[key] = nxt if nxt else cur
    return out


def dedupe_broker_contacts(supabase_client=None) -> dict[str, int]:
    """Recompute match_keys and merge duplicate contact rows into one."""
    db = supabase_client or supabase
    rows = (
        db.table("broker_contacts")
        .select("id, match_key, attachment_id, parent_email_id, row_order, used_fallback, updated_at, "
                + ", ".join(CONTACT_FIELD_KEYS))
        .execute()
    ).data or []
    if not rows:
        return {"merged": 0, "updated": 0}

    def richness(r: dict) -> tuple:
        filled = sum(1 for k in CONTACT_FIELD_KEYS if _clean_contact_val(r.get(k)))
        return (filled, r.get("updated_at") or "")

    rows_sorted = sorted(rows, key=richness)
    by_key: dict[str, dict[str, Any]] = {}
    merged = 0
    updated = 0

    for row in rows_sorted:
        key = contact_match_key(row) or (row.get("match_key") or "")
        if not key:
            # Keep orphan rows unique so they do not collapse together
            key = f"orphan:{row['id']}"
        if key not in by_key:
            if key != (row.get("match_key") or ""):
                db.table("broker_contacts").update({
                    "match_key": key,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", row["id"]).execute()
                row["match_key"] = key
                updated += 1
            by_key[key] = row
            continue

        survivor = by_key[key]
        merged_fields = _merge_contact_fields(survivor, row)
        patch = dict(merged_fields)
        patch["match_key"] = key
        patch["attachment_id"] = row.get("attachment_id") or survivor.get("attachment_id")
        patch["parent_email_id"] = row.get("parent_email_id") or survivor.get("parent_email_id")
        patch["used_fallback"] = bool(survivor.get("used_fallback")) and bool(
            row.get("used_fallback")
        )
        patch["updated_at"] = datetime.now(timezone.utc).isoformat()
        db.table("broker_contacts").update(patch).eq("id", survivor["id"]).execute()
        for f, v in patch.items():
            survivor[f] = v
        db.table("broker_contacts").delete().eq("id", row["id"]).execute()
        merged += 1

    if merged or updated:
        logger.info(
            "Broker contacts rematch: merged=%d updated_keys=%d",
            merged,
            updated,
        )
    return {"merged": merged, "updated": updated}


def _contact_row_db_payload(
    attachment_id: str,
    parent_email_id: str | None,
    contact: dict[str, str],
    row_order: int,
    used_fallback: bool,
    *,
    match_key: str = "",
) -> dict[str, Any]:
    other = (contact.get("other_info") or "").strip()
    if other.lower() == FALLBACK_OTHER_INFO:
        other = ""
    row: dict[str, Any] = {
        "attachment_id": attachment_id,
        "parent_email_id": parent_email_id,
        "row_order": row_order,
        "used_fallback": used_fallback,
        "match_key": match_key,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    for key in CONTACT_FIELD_KEYS:
        if key == "other_info":
            row[key] = other
        elif key == "status":
            row[key] = normalize_contact_status(contact.get(key))
        else:
            row[key] = (contact.get(key) or "").strip()
    return row


def save_broker_contacts_for_attachment(
    attachment_id: str,
    parent_email_id: str | None,
    contacts: list[dict[str, str]],
    *,
    used_fallback: bool | None = None,
) -> int:
    """Upsert broker contacts by global identity (email → phone → name+company).

    Same person across mails updates one row. Returns number of contacts upserted.
    """
    contacts = enrich_contacts_vessel_names(attachment_id, contacts)
    fb = contacts_used_fallback(contacts) if used_fallback is None else used_fallback

    existing_rows = (
        supabase.table("broker_contacts")
        .select(
            "id, match_key, attachment_id, parent_email_id, row_order, used_fallback, "
            + ", ".join(CONTACT_FIELD_KEYS)
        )
        .execute()
    ).data or []
    by_key: dict[str, dict[str, Any]] = {}
    for row in existing_rows:
        key = row.get("match_key") or contact_match_key(row)
        if key and key not in by_key:
            by_key[key] = row

    kept_keys: set[str] = set()
    upserted = 0

    for i, contact in enumerate(contacts):
        key = contact_match_key(contact)
        if not key:
            key = f"orphan:{attachment_id}:{i}"
        kept_keys.add(key)
        payload = _contact_row_db_payload(
            attachment_id, parent_email_id, contact, i, fb, match_key=key
        )

        existing = by_key.get(key)
        if existing:
            merged = _merge_contact_fields(existing, payload)
            patch = dict(merged)
            patch["match_key"] = key
            patch["attachment_id"] = attachment_id
            patch["parent_email_id"] = parent_email_id
            patch["row_order"] = i
            # Keep fallback flag only if both sides were fallback
            patch["used_fallback"] = bool(existing.get("used_fallback")) and bool(fb)
            patch["updated_at"] = datetime.now(timezone.utc).isoformat()
            supabase.table("broker_contacts").update(patch).eq(
                "id", existing["id"]
            ).execute()
            existing.update(patch)
            upserted += 1
            continue

        result = supabase.table("broker_contacts").insert(payload).execute()
        if result.data:
            by_key[key] = result.data[0]
        upserted += 1

    # Drop stale rows still attributed to this attachment but not in the new extract
    stale = (
        supabase.table("broker_contacts")
        .select("id, match_key")
        .eq("attachment_id", attachment_id)
        .execute()
    ).data or []
    for row in stale:
        mk = row.get("match_key") or ""
        if mk and mk not in kept_keys:
            supabase.table("broker_contacts").delete().eq("id", row["id"]).execute()

    return upserted


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
        save_broker_contacts_for_attachment(aid, parent_email_id, [], used_fallback=False)
        await sse_manager.send(job_id, "contact_attachment_done", {
            "attachment_id": aid,
            "filename": filename,
            "contact_count": 0,
        })
        return 0

    gap = max(2.0, settings.EXTRACTION_REQUEST_DELAY_SEC)
    await asyncio.sleep(gap)

    contacts, used_fallback = await extract_contacts_from_attachment(
        raw,
        filename=filename,
        signature_emails=att.get("signature_emails") or "",
        signature_phones=att.get("signature_phones") or "",
    )
    count = save_broker_contacts_for_attachment(
        aid, parent_email_id, contacts, used_fallback=used_fallback
    )

    await sse_manager.send(job_id, "contact_attachment_done", {
        "attachment_id": aid,
        "filename": filename,
        "contact_count": count,
        "used_fallback": used_fallback,
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
    (LLM + remap + signature fallback) and save to broker_contacts.
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
