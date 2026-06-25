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
from database import supabase
from config import settings
from sse_manager import sse_manager

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
1. Find EVERY vessel/ship mentioned — whether listed as "open positions", "available tonnage", "please propose cargo for", or any similar phrasing. All of these are vessel position records.
2. Return ONLY a raw JSON array. No markdown code blocks, no explanation, no prefix or suffix text.
3. Each element in the array represents ONE vessel.
4. Each vessel object must contain ALL specifications mentioned for that vessel as key-value pairs.
5. ALWAYS include a "region" key = the PRIMARY port or area where the vessel is currently open/available.
   - Look for phrases like: "Open at MERAK", "open in SINGAPORE", "available at ECI", "position at FUJAIRAH",
     "ETA SINGAPORE", "next open: HONG KONG", "open YANGON", "delivery CHENNAI", etc.
   - Use the OPEN PORT/LOCATION, not the seeking/routing destination.
   - Examples of good region values: "MERAK", "SINGAPORE", "ECI", "HONG KONG", "FUJAIRAH", "MUMBAI",
     "YANGON", "CHIBA", "DURBAN", "GEELONG", "NHA BE", "TANJUNG UBAN", "SIKKA"
   - If the vessel is open in multiple locations pick the first/primary one.
   - If truly no open location is mentioned, set region to "UNSPECIFIED".
   - NEVER leave region as null or empty string.
6. ALWAYS include a "vessel_name" key with the ship's name (e.g. "M/T INCHEON CHEMI", "RAFFLES SAMURAI").
7. All keys must be lowercase with underscores (e.g. "dwt", "built", "last_cargo", "open_date", "coating").
8. Values must be strings. Use "UNKNOWN" only if a field is explicitly mentioned but its value is illegible.
9. Do NOT include keys that are completely absent for a specific vessel.
10. If the document contains absolutely no vessel/ship data (e.g. only contact information), return an empty array: []
11. vessel_name codes like "GS/J19", "OT/MR" etc. are vessel identifiers — extract them as the vessel_name.

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
        .select("id, status")
        .eq("parent_email_id", email_id)
        .execute()
    )
    return [
        row["id"]
        for row in (rows.data or [])
        if row.get("status") in RETRYABLE_STATUSES
    ]


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

        vessels_data: list[dict] = []
        last_error: str = ""
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
                            "content": EXTRACTION_PROMPT.format(raw_text=raw_text[:12000]),
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
            normalised = {k.lower().replace(" ", "_"): str(v) for k, v in vessel.items()}
            supabase.table("vessels").insert({
                "attachment_id": attachment_id,
                "dynamic_data": normalised,
                "region": region,
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
