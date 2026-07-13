"""
Agent 2 — Parallel Extraction
Calls the NVIDIA NIM LLM on every attachment simultaneously using
asyncio.gather(). Each call extracts a JSON array of vessel objects
from the raw .eml text and saves them to the vessels table.
"""
import asyncio
import json
import re
import logging
from typing import Any

from openai import AsyncOpenAI
from database import supabase
from config import settings
from sse_manager import sse_manager

logger = logging.getLogger(__name__)

nvidia_client = AsyncOpenAI(
    base_url=settings.NVIDIA_API_BASE_URL,
    api_key=settings.NVIDIA_API_KEY,
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


def _extract_json_array(text: str) -> list[dict]:
    """Robustly pull a JSON array from potentially messy LLM output."""
    # Strip markdown code fences
    text = re.sub(r"```(?:json)?\s*", "", text)
    text = re.sub(r"```\s*$", "", text, flags=re.MULTILINE)
    text = text.strip()

    # Strategy 1: find the outermost single JSON array
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if match:
        try:
            result = json.loads(match.group())
            if isinstance(result, list):
                return result
        except json.JSONDecodeError:
            pass

    # Strategy 2: merge multiple JSON arrays (LLM sometimes outputs one per section)
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

    # Strategy 3: try the whole stripped text
    try:
        result = json.loads(text)
        if isinstance(result, list):
            return result
    except json.JSONDecodeError:
        pass

    # Strategy 4: truncated JSON — try to recover by closing the array
    if "[" in text:
        truncated = text[text.index("["):]
        # Close any open objects and the array
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
        # Mark as extracting
        supabase.table("attachments").update({"status": "extracting"}).eq("id", attachment_id).execute()
        await sse_manager.send(job_id, "extraction_started", {
            "attachment_id": attachment_id,
            "filename": filename,
        })

        # Retry loop (up to 3 attempts)
        vessels_data: list[dict] = []
        last_error: str = ""
        for attempt in range(1, 4):
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
                    timeout=120,  # prevent a hung request from stalling the whole batch
                )
                content = response.choices[0].message.content or ""
                vessels_data = _extract_json_array(content)
                break  # Success

            except Exception as exc:
                last_error = str(exc)
                logger.warning("Extraction attempt %d failed for %s: %s", attempt, filename, exc)
                if attempt < 3:
                    await asyncio.sleep(2 ** attempt)  # Exponential back-off

        if not vessels_data and last_error:
            supabase.table("attachments").update({
                "status": "error",
                "error_message": last_error,
            }).eq("id", attachment_id).execute()
            await sse_manager.send(job_id, "extraction_error", {
                "attachment_id": attachment_id,
                "filename": filename,
                "error": last_error,
            })
            return []

        # Persist each vessel as a separate row
        for vessel in vessels_data:
            region = vessel.pop("region", None)
            # Normalise keys: lowercase + underscores
            normalised = {k.lower().replace(" ", "_"): str(v) for k, v in vessel.items()}
            supabase.table("vessels").insert({
                "attachment_id": attachment_id,
                "dynamic_data": normalised,
                "region": region,
            }).execute()

        supabase.table("attachments").update({"status": "done"}).eq("id", attachment_id).execute()
        await sse_manager.send(job_id, "extraction_done", {
            "attachment_id": attachment_id,
            "filename": filename,
            "vessel_count": len(vessels_data),
        })

        return vessels_data


async def run_extraction(job_id: str, attachment_ids: list[str]) -> int:
    """
    Run extraction on all attachments in parallel (max 10 concurrent).
    Returns total number of vessels extracted.
    """
    # Fetch attachment metadata
    rows = (
        supabase.table("attachments")
        .select("id, filename, raw_text")
        .in_("id", attachment_ids)
        .execute()
    )
    attachments = rows.data or []

    # Cap concurrency to avoid hammering the API
    semaphore = asyncio.Semaphore(10)

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

    await sse_manager.send(job_id, "all_extractions_done", {
        "total_vessels": total_vessels,
    })
    return total_vessels
