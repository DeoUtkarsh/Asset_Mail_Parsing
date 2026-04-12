"""
Extract broker contact emails and phone numbers from each attachment body (signature /
contact blocks) via LLM, then persist on that attachment row. The validation grid reads
signature_emails / signature_phones from vessels_full → attachments (per source file).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from openai import AsyncOpenAI

from config import settings
from database import supabase
from sse_manager import sse_manager

logger = logging.getLogger(__name__)

nvidia_client = AsyncOpenAI(
    base_url=settings.NVIDIA_API_BASE_URL,
    api_key=settings.NVIDIA_API_KEY,
)

SIGNATURE_PROMPT = """\
You are extracting CONTACT INFORMATION from the tail of a shipbroking email.

Rules:
1. Focus on SIGNATURE / OFFICE CONTACT blocks: lines with Tel, Mobile, Cell, DID, Email, mailto, company names, ICE. Ignore vessel bullet lists (Q88, DWT, IMO Type, SIRE, ETA, Seeking) ONLY when they appear as specs above the broker company name — but DO extract Tel/Mobile/Email lines that appear after the person or company name (e.g. AN BINH LOGISTICS, PT. Samudera, BainBridge).
2. Extract EVERY distinct professional email (with @) and EVERY phone that has a country code (+84, +62, +971, +65, +44, +1, etc.) or appears after Tel:/Mobile:/Cell:/DID:.
3. Output ONLY valid JSON with exactly two keys:
   - "emails": addresses separated by " ; " (space-semicolon-space). Never return empty if the text clearly shows Email: or @domain lines in a signature. Fix broken spacing like "operations @domain.com" to "operations@domain.com".
   - "phones": separated by " ; ". Normalize to digits with leading + where the source shows a country code (e.g. +84 (28) 38208082 → +842838208082 or keep readable spacing). If none: "".
4. Ignore urldefense.proofpoint.com, GDPR walls of text, OGYRE, unsubscribe — but still extract contacts ABOVE those footers.
5. Do not invent; only use text below.

TEXT (possibly truncated from end of message):
{chunk}

JSON OUTPUT ONLY:"""


def _strip_noise_lines(text: str) -> str:
    """Remove obvious footer/noise lines before sending to the LLM."""
    skip_patterns = (
        r"urldefense\.proofpoint\.com",
        r"proofpoint",
        r"\bGDPR\b",
        r"General Data Protection",
        r"\bOGYRE\b",
        r"plastic waste",
        r"unsubscribe",
        r"mailing list",
        r"click here to",
        r"Thank you\s*$",
    )
    combined = "|".join(f"(?:{p})" for p in skip_patterns)
    rx = re.compile(combined, re.I)
    out_lines: list[str] = []
    for line in text.splitlines():
        if rx.search(line):
            continue
        out_lines.append(line)
    return "\n".join(out_lines)


_JUNK_EMAIL_SUBSTR = re.compile(
    r"urldefense|proofpoint|noreply|no-reply|donotreply|unsubscribe|\.png@|\.jpg@|image\d+@",
    re.I,
)
_EMAIL_FIND = re.compile(
    r"\b([a-zA-Z0-9][a-zA-Z0-9._%+-]*@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b",
)
# International numbers starting with +; allow spaces/parens (common in signatures)
_PLUS_PHONE_SCAN = re.compile(r"\+[\d\s()./-]{10,}")
_LABEL_LINE = re.compile(
    r"^\s*(?:Tel|Mobile|Cell|DID|Phone|Fax)\s*:\s*(.+?)\s*$",
    re.I,
)


def _text_before_confidentiality_block(s: str) -> str:
    """Legal footers often confuse models; regex runs on the part above them."""
    m = re.search(r"\bCONFIDENTIALITY\s+NOTICE\b", s, re.I)
    return s[: m.start()] if m else s


def _fix_spaced_email(s: str) -> str:
    return re.sub(r"(\w)\s+@", r"\1@", s)


def _normalize_phone_token(raw: str) -> str:
    raw = raw.strip().strip("|").strip()
    if not raw:
        return ""
    has_plus = "+" in raw[:3] or raw.strip().startswith("+")
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 8 or len(digits) > 15:
        return ""
    if has_plus or len(digits) >= 10:
        return "+" + digits
    return digits


def _phone_key(norm: str) -> str:
    return re.sub(r"\D", "", norm)


def regex_fallback_signature(chunk: str) -> dict[str, str]:
    """
    Deterministic extraction when the LLM returns empty or partial results.
    """
    if not chunk or len(chunk) < 20:
        return {"emails": "", "phones": ""}
    work = _text_before_confidentiality_block(chunk)
    work = _fix_spaced_email(work)

    emails_ordered: list[str] = []
    seen_e: set[str] = set()
    for m in _EMAIL_FIND.finditer(work):
        addr = m.group(1).strip().lower().strip("<>")
        if "@" not in addr or _JUNK_EMAIL_SUBSTR.search(addr):
            continue
        if addr in seen_e:
            continue
        seen_e.add(addr)
        emails_ordered.append(addr)

    phones_ordered: list[str] = []
    seen_p: set[str] = set()

    for m in _PLUS_PHONE_SCAN.finditer(work):
        norm = _normalize_phone_token(m.group(0))
        if not norm:
            continue
        key = _phone_key(norm)
        if len(key) < 8 or key in seen_p:
            continue
        seen_p.add(key)
        phones_ordered.append(norm)

    for line in work.splitlines():
        m = _LABEL_LINE.match(line)
        if not m:
            continue
        segment = m.group(1).strip()
        for sub in re.split(r"\s*\|\s*", segment):
            sub = sub.strip()
            if not sub:
                continue
            norm = _normalize_phone_token(sub)
            if not norm:
                continue
            key = _phone_key(norm)
            if len(key) < 8 or key in seen_p:
                continue
            seen_p.add(key)
            phones_ordered.append(norm)

    return {
        "emails": " ; ".join(emails_ordered),
        "phones": " ; ".join(phones_ordered),
    }


def _merge_signature_strings(llm: str, fb: str, is_email: bool) -> str:
    """Union LLM + fallback, preserve order (LLM first), dedupe."""
    parts: list[str] = []
    seen: set[str] = set()

    def add_from(s: str) -> None:
        if not s:
            return
        for piece in re.split(r"\s*;\s*", s.strip()):
            piece = piece.strip()
            if not piece:
                continue
            key = piece.lower() if is_email else _phone_key(_normalize_phone_token(piece) or piece)
            if key in seen:
                continue
            seen.add(key)
            parts.append(piece)

    add_from(llm)
    add_from(fb)
    return " ; ".join(parts)


def preprocess_for_signature(raw_text: str, max_chars: int = 12000) -> str:
    """
    Focus on the end of the message (signature is usually last) and drop noise.
    """
    if not raw_text:
        return ""
    cleaned = _strip_noise_lines(raw_text)
    # Drop Word/HTML leak lines that bloat the tail and confuse the model
    wlines: list[str] = []
    for ln in cleaned.splitlines():
        if re.search(r"mso-|v\\:\*|@font-face|page-break", ln, re.I):
            continue
        wlines.append(ln)
    cleaned = "\n".join(wlines)
    cleaned = re.sub(r"<mailto:[^>]+>", "", cleaned, flags=re.I)
    cleaned = re.sub(r"<tel:[^>]+>", "", cleaned, flags=re.I)
    tail = cleaned[-max_chars:] if len(cleaned) > max_chars else cleaned
    return tail.strip()


def _parse_llm_json_obj(text: str) -> dict[str, str]:
    text = re.sub(r"```(?:json)?\s*", "", text)
    text = re.sub(r"```\s*$", "", text, flags=re.MULTILINE).strip()
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return {
                "emails": str(obj.get("emails") or "").strip(),
                "phones": str(obj.get("phones") or "").strip(),
            }
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[^{}]*\}", text, re.DOTALL)
    if m:
        try:
            obj = json.loads(m.group())
            if isinstance(obj, dict):
                return {
                    "emails": str(obj.get("emails") or "").strip(),
                    "phones": str(obj.get("phones") or "").strip(),
                }
        except json.JSONDecodeError:
            pass
    return {"emails": "", "phones": ""}


async def extract_signature_for_chunk(chunk: str) -> dict[str, str]:
    """LLM first, then merge with regex fallback for missing/partial fields."""
    fb = regex_fallback_signature(chunk)
    llm = await llm_extract_signature_chunk(chunk)
    le = (llm.get("emails") or "").strip()
    lp = (llm.get("phones") or "").strip()
    fe = (fb.get("emails") or "").strip()
    fp = (fb.get("phones") or "").strip()

    emails = _merge_signature_strings(le, fe, is_email=True)
    phones = _merge_signature_strings(lp, fp, is_email=False)

    if (fe or fp) and (not le or not lp):
        logger.info(
            "[Signature] fallback filled gaps (llm emails=%s phones=%s → merged emails=%s phones=%s)",
            bool(le),
            bool(lp),
            bool(emails),
            bool(phones),
        )
    return {"emails": emails, "phones": phones}


async def llm_extract_signature_chunk(chunk: str) -> dict[str, str]:
    if not chunk or len(chunk) < 20:
        return {"emails": "", "phones": ""}
    try:
        resp = await nvidia_client.chat.completions.create(
            model=settings.NVIDIA_LLM_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "You extract contact emails and phones from signatures. Output only valid JSON.",
                },
                {"role": "user", "content": SIGNATURE_PROMPT.format(chunk=chunk[:14000])},
            ],
            temperature=0.1,
            max_tokens=512,
        )
        content = resp.choices[0].message.content or ""
        return _parse_llm_json_obj(content)
    except Exception as exc:
        logger.warning("[Signature] LLM chunk failed: %s", exc)
        return {"emails": "", "phones": ""}


async def run_parent_signature_extraction(job_id: str, email_id: str) -> None:
    """
    For each attachment under this parent, run signature extraction on the text tail
    and save emails/phones on that attachment row.
    """
    try:
        await _run_parent_signature_extraction_impl(job_id, email_id)
    except Exception as exc:
        logger.exception("[Signature] Failed for parent %s: %s", email_id, exc)
        await sse_manager.send(job_id, "signature_extraction_error", {
            "email_id": email_id,
            "error": str(exc),
        })


async def _run_parent_signature_extraction_impl(job_id: str, email_id: str) -> None:
    await sse_manager.send(job_id, "signature_extraction_started", {
        "message": "Extracting signature emails & phones…",
    })

    rows = (
        supabase.table("attachments")
        .select("id, filename, raw_text")
        .eq("parent_email_id", email_id)
        .execute()
    )
    attachments = rows.data or []

    preview_first = ""
    updated = 0

    for att in attachments:
        aid = att.get("id")
        raw = att.get("raw_text") or ""
        chunk = preprocess_for_signature(raw)
        if len(chunk) < 30:
            supabase.table("attachments").update({
                "signature_emails": None,
                "signature_phones": None,
            }).eq("id", aid).execute()
            continue
        result = await extract_signature_for_chunk(chunk)
        emails = (result.get("emails") or "").strip()
        phones = (result.get("phones") or "").strip()
        supabase.table("attachments").update({
            "signature_emails": emails or None,
            "signature_phones": phones or None,
        }).eq("id", aid).execute()
        updated += 1
        if emails and not preview_first:
            preview_first = emails[:120] + ("…" if len(emails) > 120 else "")
        await asyncio.sleep(0.15)

    logger.info(
        "[Signature] parent=%s attachments_updated=%d",
        email_id,
        updated,
    )

    await sse_manager.send(job_id, "signature_extraction_done", {
        "email_id": email_id,
        "signature_preview": preview_first or f"{updated} source file(s) updated",
    })


