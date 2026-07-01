"""
Agent 2 — Parallel Extraction
Calls the NVIDIA NIM LLM on every attachment using bounded concurrency.
Each call extracts a JSON array of vessel objects from the raw .eml text.
"""
import asyncio
import json
import re
import logging
from typing import Any

from openai import AsyncOpenAI, RateLimitError
from column_defs import map_raw_to_standard
from database import supabase
from config import settings
from sse_manager import sse_manager
from agents.vertical_tonnage import (
    format_vertical_tonnage_for_llm,
    looks_like_vertical_tonnage,
    parse_vertical_tonnage_vessels,
)
from agents.eta_foc import enrich_vessels_eta_foc
from agents.structured_parsers import is_image_only_attachment
from agents.vessel_recovery import apply_extraction_fallback, recover_vessels_without_llm

logger = logging.getLogger(__name__)

RETRYABLE_STATUSES = ("error", "pending", "extracting")

nvidia_client = AsyncOpenAI(
    base_url=settings.NVIDIA_API_BASE_URL,
    api_key=settings.NVIDIA_API_KEY,
    max_retries=0,
)

EXTRACTION_PROMPT = """\
You are an expert shipbroking data extractor. Extract ALL vessel/ship position data from the text below.

CRITICAL RULES:
1. Find EVERY vessel/ship mentioned — open positions, available tonnage, "please propose cargo for", etc.
2. Return ONLY a raw JSON array. No markdown, no explanation.
3. Each element = ONE vessel.
4. Use ONLY these keys per vessel (omit a key if truly unknown — do not invent):
   - vessel_name, imo, call_sign, year_built, vessel_type, cargo_type, dwt_sdwt, cbm, draft, flag, eta_foc
   - region (primary open port/area, e.g. SINGAPORE, MERAK, FUJAIRAH — never empty; use UNSPECIFIED if unknown)
   - open_location, opening_date, cargo_history_combo, tank_coating
   - sire_date, sire_location, cdi_date, cdi_location, remarks, other_info, q88, status
5. eta_foc: from lines like "ETA FOC: around 19TH June 2026 in ECI" — location + date window combined (not open port/date).
6. dwt_sdwt: single string, e.g. "19000 / 19999" or "13000" if only one value.
7. cargo_history_combo: single string merging last cargoes / L3C, e.g. "CPP / PALMS / CSS".
8. All keys lowercase with underscores. All values strings.
9. vessel_name codes like "GS/J19" are valid vessel names.
10. VERTICAL TABLE FORMAT: If headers appear on separate lines (PORT OPEN, DATES, DWT, CUB/CBM)
   followed by repeating 5-line groups (vessel name, port, date, dwt, cbm), each group is ONE vessel.
   A normalized table may appear at the top of the text — use it.
11. If no vessel data at all, return [].

TEXT TO PARSE:
{raw_text}

JSON ARRAY OUTPUT:"""


def _is_rate_limit_error(exc: Exception) -> bool:
    if isinstance(exc, RateLimitError):
        return True
    msg = str(exc).lower()
    return "429" in msg or "too many requests" in msg or "rate limit" in msg


def _retry_delay_seconds(exc: Exception, attempt: int) -> float:
    if _is_rate_limit_error(exc):
        base = settings.EXTRACTION_RATE_LIMIT_BASE_SEC
        return min(base * (2 ** (attempt - 1)), 90.0)
    return min(2.0 ** attempt, 30.0)


def get_retryable_attachment_ids(email_id: str) -> list[str]:
    rows = (
        supabase.table("attachments")
        .select("id, status, raw_text, filename")
        .eq("parent_email_id", email_id)
        .execute()
    )
    retry_ids: list[str] = []
    for row in rows.data or []:
        if row.get("status") in RETRYABLE_STATUSES:
            retry_ids.append(row["id"])
            continue
        if row.get("status") != "done":
            continue
        vessel_rows = (
            supabase.table("vessels")
            .select("id")
            .eq("attachment_id", row["id"])
            .limit(1)
            .execute()
        )
        if vessel_rows.data:
            continue
        raw = row.get("raw_text") or ""
        fname = row.get("filename") or ""
        if looks_like_vertical_tonnage(raw) and parse_vertical_tonnage_vessels(raw):
            retry_ids.append(row["id"])
            continue
        if _rules_would_recover(fname, raw):
            retry_ids.append(row["id"])
    return retry_ids


def _rules_would_recover(filename: str, raw_text: str) -> bool:
    recovered, _ = recover_vessels_without_llm(filename, raw_text)
    return bool(recovered)


def _prepare_llm_text(raw_text: str) -> str:
    """Prepend normalized table when vertical tonnage layout is detected."""
    table = format_vertical_tonnage_for_llm(raw_text)
    body = raw_text[:12000]
    if table:
        return (
            "NORMALIZED TABLE (from vertical broker list — extract every row):\n"
            f"{table}\n\n--- ORIGINAL MESSAGE ---\n{body}"
        )
    return body


def prepare_attachments_for_retry(attachment_ids: list[str]) -> None:
    for att_id in attachment_ids:
        supabase.table("vessels").delete().eq("attachment_id", att_id).execute()
        supabase.table("attachments").update({
            "status": "pending",
            "error_message": None,
        }).eq("id", att_id).execute()


def _extract_json_array(text: str) -> list[dict]:
    """Robustly pull a JSON array from potentially messy LLM output."""
    text = re.sub(r"```(?:json)?\s*", "", text)
    text = re.sub(r"```\s*$", "", text, flags=re.MULTILINE)
    text = text.strip()

    match = re.search(r"\[.*\]", text, re.DOTALL)
    if match:
        try:
            result = json.loads(match.group())
            if isinstance(result, list):
                return result
        except json.JSONDecodeError:
            pass

    all_arrays: list[dict] = []
    for m in re.finditer(r"\[.*?\]", text, re.DOTALL):
        try:
            chunk = json.loads(m.group())
            if isinstance(chunk, list):
                all_arrays.extend(chunk)
        except json.JSONDecodeError:
            pass
    if all_arrays:
        logger.info("Merged %d vessels from multiple JSON arrays.", len(all_arrays))
        return all_arrays

    try:
        result = json.loads(text)
        if isinstance(result, list):
            return result
    except json.JSONDecodeError:
        pass

    if "[" in text:
        truncated = text[text.index("["):]
        open_braces = truncated.count("{") - truncated.count("}")
        if open_braces > 0:
            truncated += "}" * open_braces
        if not truncated.rstrip().endswith("]"):
            truncated += "]"
        try:
            result = json.loads(truncated)
            if isinstance(result, list) and result:
                logger.warning("Recovered %d vessels from truncated JSON.", len(result))
                return result
        except json.JSONDecodeError:
            pass

    logger.warning(
        "Could not parse JSON array from LLM response. Returning [].\n"
        "First 500 chars of response: %s",
        text[:500],
    )
    return []


async def _extract_single_attachment(
    job_id: str,
    attachment_id: str,
    filename: str,
    raw_text: str,
    semaphore: asyncio.Semaphore,
) -> list[dict]:
    """Run the LLM on one attachment and save the extracted vessels."""
    async with semaphore:
        supabase.table("attachments").update({"status": "extracting"}).eq("id", attachment_id).execute()
        await sse_manager.send(job_id, "extraction_started", {
            "attachment_id": attachment_id,
            "filename": filename,
        })

        if is_image_only_attachment(raw_text, filename):
            logger.info(
                "[Extraction] Image-only attachment — skipping LLM: %s",
                filename,
            )
            vessels_data, recovery_source = recover_vessels_without_llm(filename, raw_text)
            if vessels_data:
                logger.info(
                    "[Extraction] Recovered %d vessels from %s via %s (image-only path)",
                    len(vessels_data),
                    filename,
                    recovery_source,
                )
            last_error = ""
        else:
            vessels_data = []
            last_error = ""
            max_attempts = settings.EXTRACTION_MAX_ATTEMPTS

            for attempt in range(1, max_attempts + 1):
                try:
                    response = await nvidia_client.chat.completions.create(
                        model=settings.NVIDIA_LLM_MODEL,
                        messages=[
                            {
                                "role": "system",
                                "content": "You are a precise shipbroking data extractor. Output only valid JSON.",
                            },
                            {
                                "role": "user",
                                "content": EXTRACTION_PROMPT.format(
                                    raw_text=_prepare_llm_text(raw_text),
                                ),
                            },
                        ],
                        temperature=0.05,
                        max_tokens=8192,
                    )
                    content = response.choices[0].message.content or ""
                    vessels_data = _extract_json_array(content)
                    last_error = ""
                    break

                except Exception as exc:
                    last_error = str(exc)
                    logger.warning(
                        "Extraction attempt %d/%d failed for %s: %s",
                        attempt, max_attempts, filename, exc,
                    )
                    if attempt < max_attempts:
                        delay = _retry_delay_seconds(exc, attempt)
                        logger.info("Waiting %.1fs before retry…", delay)
                        await asyncio.sleep(delay)

            if settings.EXTRACTION_REQUEST_DELAY_SEC > 0:
                await asyncio.sleep(settings.EXTRACTION_REQUEST_DELAY_SEC)

            vessels_data, recovery_source = apply_extraction_fallback(
                raw_text, filename, vessels_data,
            )
            if vessels_data and recovery_source != "llm":
                logger.info(
                    "[Extraction] %s fallback recovered %d vessels from %s",
                    recovery_source,
                    len(vessels_data),
                    filename,
                )
            if vessels_data and last_error:
                logger.info(
                    "[Extraction] Rule/vertical fallback recovered %s after LLM error",
                    filename,
                )
                last_error = ""

        if last_error and not vessels_data:
            supabase.table("attachments").update({
                "status": "error",
                "error_message": last_error[:500],
            }).eq("id", attachment_id).execute()
            await sse_manager.send(job_id, "extraction_error", {
                "attachment_id": attachment_id,
                "filename": filename,
                "error": last_error,
            })
            return []

        for vessel in vessels_data:
            region = vessel.pop("region", None)
            raw = {k.lower().replace(" ", "_"): str(v) for k, v in vessel.items()}
            dynamic_data, region = map_raw_to_standard(raw, region)
            supabase.table("vessels").insert({
                "attachment_id": attachment_id,
                "dynamic_data": dynamic_data,
                "region": region or "UNSPECIFIED",
            }).execute()

        supabase.table("attachments").update({
            "status": "done",
            "error_message": None,
        }).eq("id", attachment_id).execute()
        await sse_manager.send(job_id, "extraction_done", {
            "attachment_id": attachment_id,
            "filename": filename,
            "vessel_count": len(vessels_data),
        })

        return vessels_data


async def run_extraction(job_id: str, attachment_ids: list[str]) -> int:
    """Run extraction on attachments with bounded concurrency. Returns total vessels."""
    if not attachment_ids:
        return 0

    rows = (
        supabase.table("attachments")
        .select("id, filename, raw_text")
        .in_("id", attachment_ids)
        .execute()
    )
    attachments = rows.data or []

    concurrency = max(1, settings.EXTRACTION_CONCURRENCY)
    semaphore = asyncio.Semaphore(concurrency)
    logger.info(
        "Starting extraction for %d attachments (concurrency=%d)",
        len(attachments),
        concurrency,
    )

    tasks = [
        _extract_single_attachment(
            job_id,
            att["id"],
            att["filename"],
            att.get("raw_text") or "",
            semaphore,
        )
        for att in attachments
    ]

    results = await asyncio.gather(*tasks, return_exceptions=True)

    total_vessels = 0
    for r in results:
        if isinstance(r, list):
            total_vessels += len(r)
        elif isinstance(r, Exception):
            logger.error("Extraction task raised: %s", r)

    await sse_manager.send(job_id, "all_extractions_done", {
        "total_vessels": total_vessels,
    })
    return total_vessels


async def run_retry_extraction_for_email(job_id: str, email_id: str) -> int:
    """Re-run extraction only for failed, pending, or stuck attachments."""
    attachment_ids = get_retryable_attachment_ids(email_id)
    if not attachment_ids:
        return 0

    prepare_attachments_for_retry(attachment_ids)
    supabase.table("parent_emails").update({"status": "extracting"}).eq("id", email_id).execute()
    logger.info(
        "Retrying extraction for email_id=%s (%d attachments)",
        email_id,
        len(attachment_ids),
    )
    return await run_extraction(job_id, attachment_ids)
