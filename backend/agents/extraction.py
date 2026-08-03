"""
Agent 2 — Parallel Extraction
Calls Claude (Anthropic) on every broker email simultaneously using
asyncio.gather(). Each call reads the email body text AND any attached
images / PDF / spreadsheet / Word documents (vision), extracts a JSON array
of vessel objects, and saves them to the vessels table.
"""
import asyncio
import json
import re
import logging
from typing import Any

from database import supabase
from config import settings
from column_defs import (
    resolve_vessel_company,
    mark_bare_dwt_ai_flag,
    mark_bare_year_ai_flag,
    pick_owner_company_with_ai,
    map_raw_to_standard,
    normalize_columns_in_email,
    reconcile_columns_in_email,
)
from sse_manager import sse_manager
from llm import claude_client, files_to_content_blocks
from verification import try_auto_verify_attachment
from email_text import prepare_extraction_text
from file_storage import read_bytes

# ── NVIDIA NIM (legacy — kept for reference, no longer used) ──────────────────
# from openai import AsyncOpenAI
# nvidia_client = AsyncOpenAI(
#     base_url=settings.NVIDIA_API_BASE_URL,
#     api_key=settings.NVIDIA_API_KEY,
# )

logger = logging.getLogger(__name__)

EXTRACTION_PROMPT = """\
You are an expert shipbroking data extractor. Extract ALL vessel/ship position data from this email.
The position list may appear in the TEXT below and/or inside ATTACHED images, PDFs, spreadsheets, or
Word documents provided alongside this message — read EVERY source and merge them into one vessel list.

Return ONLY raw JSON (no markdown, no commentary) in this shape:
{{
  "columns_in_email": ["vessel_name", "dwt_sdwt", "region", ...],
  "vessels": [ {{ one vessel object }}, ... ]
}}

columns_in_email — list every column KEY (from KEYS below) that the source email actually contains
as a table header, image-table column, or repeated labelled field. Examples:
- Hafnia image table with VESSEL/DWT/BUILT/IMO/COATING/OPEN/DATES/REMARKS → include those keys only;
  do NOT include direction or cargo_history_combo if those columns are absent.
- N.E. Shipping text with DIRECTION TO ANY BOUND lines → include direction.
- Womar table with Last Cargo / Remarks column → include cargo_history_combo.
Always include vessel_name when any vessel is listed. Include company when a owner/operator name
appears in letterhead, title, or signature. CRITICAL: if you put a KEY on ANY vessel object,
that KEY MUST also appear in columns_in_email (e.g. open_location / opening_date filled on vessels
→ both keys in columns_in_email). If no vessel data at all: {{"columns_in_email": [], "vessels": []}}

Each element in vessels is ONE vessel object.
Use EXACTLY the key names listed below on each vessel. OMIT a key if that field is not present
for the vessel (do NOT invent values). All values must be strings.

KEYS:
- "company": the OWNER / OPERATOR company that owns the tonnage — read it from the letterhead, logo,
  title, table header or signature (e.g. "Hafnia Chemicals", "Ardmore Shipping", "Womar Logistics",
  "Stolt Tankers", "N.E. Shipping Pte Ltd", "Stealth Maritime Corp. S.A.", "Empire Smart Freight LLC",
  "VietSea Company", "Shell"). Also use the email SUBJECT brand when the body is only a position table
  (e.g. subject "Shell Eastern Chemical and Coastal Positions…" → company "Shell").
  This is NEVER a person name (Rohan Kalantre), NEVER a desk/department
  ("Chartering Dept", "Commercial Team", "Ops"). Use the SAME company for every vessel in this email.
- "vessel_name": ship name incl. prefix/code (e.g. "M/T OCEAN JUPITER", "PVT Jupiter", "GS/J19",
  "SRIWANGI", "SC LIAONING"). NEVER use PIC / contact / person-in-charge columns as vessel_name
  (e.g. "DANIEL" under a PIC header is a person — skip it and take the real vessel column).
- "imo": IMO number ONLY when it is a 7-digit IMO number. Do NOT put IMO type here.
- "imo_type": chemical/tank IMO type codes only (e.g. "1", "2", "2/3", "IMO II"). Never put a
  7-digit IMO number here.
- "year_built": year or build date (e.g. "2010", "Feb 2008", "2015").
- "dwt_sdwt": deadweight DWT, or "DWT / SDWT" when both are given. Copy the number EXACTLY as
  written in the source. If the mail says "49", return "49" (NOT "49000" / "49,000"). If it says
  "160k" or "107.5k", keep the k form (e.g. "160k"). Do not expand or invent scale.
- "cbm": cubic capacity / M3 / CUBIC. Copy EXACTLY as written (e.g. "16.2", "9117"). Do not expand.
- "tank_coating": coating / tank material (e.g. "ML", "SS/ML", "EPOXY", "MARINE LINE", "SUS 316L", "Stainless Steel").
- "vessel_type": physical ship category if stated (e.g. "Chemical", "MR", "Product Tanker", "GAS CARRIER").
  NEVER put IMO numbers or IMO type codes (2, 2/3, IMO II) here — use imo_type instead.
- "cargo_type": space / cargo info if stated (e.g. "Full Space", "Part Space").
- "direction": preferred trading / voyage direction — ONLY if mentioned. Normalize to UPPERCASE, ONE of:
  ANY, NORTHBOUND, SOUTHBOUND, EASTBOUND, WESTBOUND, WCI, AG, WCI/AG, FAR EAST, SEA, WORLDWIDE, WEST INDIA.
  Map synonyms: "any bound"/"any dir"/"direction to any bound" → ANY, "to west india bound" → WEST INDIA,
  "NB" → NORTHBOUND, "SB" → SOUTHBOUND, "feast" → FAR EAST, "ww" → WORLDWIDE, "arabian gulf" → AG.
  OMIT if not mentioned.
- "open_location": the PORT/place where the vessel is open/available (e.g. "SINGAPORE STRAIT", "Yosu",
  "Haldia, India", "Port Klang", "USG", "ZHOUSHAN", "SIHANOUKVILLE"). Use the OPEN port, not the routing destination.
  Do NOT put section AREA alone here when a separate PORT NAME column exists — use the port.
- "opening_date": open date / laycan (e.g. "20-21 Mar 2026", "18 July", "03-05 Aug 2026").
- "cargo_history_combo": last cargo / last 3 cargoes / cargo remarks (e.g. "Nap/Nap/ULSD", "5KT P/S Dir China", "NOBL").
- "region": the broad trade ZONE — PREFER the section header / AREA column the vessel is grouped under (e.g.
  "NORTHEAST ASIA", "SOUTHEAST ASIA", "SEA / ECI", "FAR EAST", "MIDDLE EAST / WCI / EAFR",
  "NORTH AMERICA", "CONT", "BSEA/MED/WAF", "STRAITS"). If there is no section header, use the open port/area.
  Strip parenthetical notes like "(open-position term)". NEVER leave region empty — use "UNSPECIFIED" if truly unknown.
- "flag": flag state (e.g. "KOREA").
- "draft": draft in metres (e.g. "7.58").
- "sire_date", "sire_location": SIRE info if present.
- "cdi_date", "cdi_location": CDI info if present.
- "remarks": short status / notes (e.g. "ON SUBS", "PPT", "REVERT", "Subs, In ballast").
- "other_info": EXTRA INFO — capture ALL leftover vessel particulars that do NOT fit another KEY.
  Prefer a semicolon-separated list of "Label: value" pairs. Include every available detail such as:
  ex-name / former name, call sign, class, yard / built details, LOA/LBP, beam, depth, GRT/NRT,
  FWA/TPC, cargo tank capacities (98% / 100%), speed & bunker consumption (ballast/laden),
  in-port consumption (idle / loading / discharging), charter flexibility (trips / short / long TC /
  voyage), "inviting offers", and similar circular facts.
  Completeness matters — do NOT shorten or drop particulars to save space.
  Do NOT repeat values already stored in other keys (vessel_name, imo, imo_type, year_built,
  dwt_sdwt, cbm, draft, flag, open_location, opening_date, vessel_type, region, remarks, etc.).
  Omit greetings, signatures, phone/Teams/web, and commercial-manager marketing footers.
- "q88": "YES" if a Q88 is mentioned/available.
- "status": e.g. "ON SUBS", "OPEN", "AVAILABLE" if stated.

RULES:
1. Find EVERY vessel — under "open positions", "available tonnage", "propose cargoes for", grouped tables, images, etc.
2. When the list is inside an IMAGE, PDF or spreadsheet attachment, READ IT and extract every row.
3. In grouped/section tables, the section title (region band) applies to ALL rows beneath it until the next title.
4. Vessel-name codes like "GS/J19", "OT/MR" are the vessel_name. Person names under PIC/contact columns are NOT.
5. If there is genuinely no vessel data (only contacts), return {{"columns_in_email": [], "vessels": []}}.
6. IGNORE crossed-out / strikethrough text everywhere (body, images, PDFs, spreadsheets). Lines or
   values with a line through them — or wrapped in ~~tildes~~ — are cancelled/obsolete. Do NOT extract
   dates, ports, directions, or any field from crossed-out text. Use only active (non-crossed-out) values.
   If a field appears ONLY as crossed-out, OMIT that key for the vessel.
7. Return vessels in the SAME ORDER they appear in the source (top-to-bottom, first listed = first in
   the vessels array). Do not sort alphabetically.
8. Put leftover facts that have no matching KEY into "other_info" (Extra Info), not into
   company/imo/vessel_name. For position circulars with long particulars blocks, other_info
   must include the FULL set of leftover labelled lines (not a short summary).
9. DUPLICATE LISTS — many circulars show the same fleet twice: a short "open tonnage" teaser
   (name + open port/date only) then a detailed particulars block (BUILT / IMO / DWT / …) that
   restarts numbering at 1. Extract each physical ship ONCE. Prefer the detailed block, but
   still include open_location / opening_date from the teaser when the detail block omits them.
10. SISTER SHIPS / SAME NAME — if two (or more) blocks share the same vessel_name but differ in
   year_built, DWT, open position, or direction, they are DIFFERENT ships. Emit a SEPARATE vessel
   object for each (e.g. two "M/V CSL-7K-500TYPE" with BLT 2003 vs BLT 2005 → two vessels).
   Never drop a block only because the name matches an earlier row.
   Never output 14 vessels when the mail only lists 7 ships twice.

TEXT TO PARSE:
{raw_text}

JSON OUTPUT:"""


def _vessel_field(vessel: dict, *keys: str) -> str:
    for k in keys:
        if k in vessel and vessel[k] not in (None, ""):
            return str(vessel[k]).strip()
        # case-insensitive fallback
        for vk, vv in vessel.items():
            if str(vk).lower().replace(" ", "_") == k.lower() and vv not in (None, ""):
                return str(vv).strip()
    return ""


def _vessel_richness(vessel: dict) -> int:
    """How complete a vessel row looks (detail block >> short teaser)."""
    score = 0
    imo = re.sub(r"\D", "", _vessel_field(vessel, "imo", "IMO"))
    if len(imo) == 7:
        score += 3
    if _vessel_field(vessel, "year_built", "Year Built"):
        score += 2
    if _vessel_field(vessel, "dwt_sdwt", "dwt", "DWT/SDWT"):
        score += 1
    if _vessel_field(vessel, "flag", "Flag"):
        score += 1
    if _vessel_field(vessel, "other_info", "other info"):
        score += 1
    if _vessel_field(vessel, "cbm", "CBM"):
        score += 1
    if _vessel_field(vessel, "open_location", "opening_date"):
        score += 1
    return score


def _norm_vessel_name(name: str) -> str:
    n = re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()
    n = re.sub(r"\b(mv|mt|m\/v|m\/t)\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def _norm_part(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def _vessel_identity_key(vessel: dict) -> str:
    """Name alone is not unique — year / DWT / open position distinguish sister ships."""
    name = _norm_vessel_name(_vessel_field(vessel, "vessel_name", "Vessel Name"))
    year = _norm_part(_vessel_field(vessel, "year_built", "Year Built", "blt", "built"))
    dwt = re.sub(r"[^\d]", "", _vessel_field(vessel, "dwt_sdwt", "dwt", "DWT"))
    open_pos = _norm_part(
        _vessel_field(
            vessel,
            "open_location",
            "opening",
            "position",
            "Open Location",
            "POSITION",
        )
    )
    return f"{name}|{year}|{dwt}|{open_pos}"


def _merge_vessel_fields(primary: dict, donor: dict) -> dict:
    """Keep primary particulars; fill blank keys from donor (teaser open port/date)."""
    merged = dict(primary)
    # Normalize donor keys to lowercase_underscore for lookup
    donor_norm: dict[str, Any] = {}
    for k, v in donor.items():
        if v in (None, ""):
            continue
        nk = str(k).lower().replace(" ", "_")
        donor_norm[nk] = v

    for k, v in list(merged.items()):
        nk = str(k).lower().replace(" ", "_")
        if v in (None, "") and nk in donor_norm:
            merged[k] = donor_norm[nk]

    # Also add donor keys that primary lacks entirely (common: open_location)
    primary_norm = {str(k).lower().replace(" ", "_") for k in merged}
    for nk, v in donor_norm.items():
        if nk not in primary_norm:
            merged[nk] = v
    return merged


def collapse_duplicate_vessel_lists(vessels_data: list[dict]) -> list[dict]:
    """
    Collapse short-teaser + detailed-particulars duplicates (7+7 → 7).

    Prefer the richer (detail) half, but MERGE open_location / opening_date
    (and other blank fields) from the teaser half — otherwise confidence drops
    even when the vessel count is correct.
    """
    if not vessels_data or len(vessels_data) < 2:
        return vessels_data

    n = len(vessels_data)
    kept = list(vessels_data)

    if n >= 4 and n % 2 == 0:
        half = n // 2
        first, second = vessels_data[:half], vessels_data[half:]

        def avg_rich(vs: list[dict]) -> float:
            return sum(_vessel_richness(v) for v in vs) / len(vs)

        def imo_hits(vs: list[dict]) -> int:
            c = 0
            for v in vs:
                imo = re.sub(r"\D", "", _vessel_field(v, "imo", "IMO"))
                if len(imo) == 7:
                    c += 1
            return c

        r1, r2 = avg_rich(first), avg_rich(second)
        i1, i2 = imo_hits(first), imo_hits(second)
        detail: list[dict] | None = None
        teaser: list[dict] | None = None
        # Teaser first, detail second
        if r1 + 1.5 <= r2 and i1 <= max(1, half // 3) and i2 >= max(1, half // 2):
            teaser, detail = first, second
        # Detail first, teaser second (rarer)
        elif r2 + 1.5 <= r1 and i2 <= max(1, half // 3) and i1 >= max(1, half // 2):
            detail, teaser = first, second

        if detail is not None and teaser is not None:
            merged_rows: list[dict] = []
            for i, rich in enumerate(detail):
                donor = teaser[i] if i < len(teaser) else {}
                merged_rows.append(_merge_vessel_fields(rich, donor))
            logger.info(
                "[Extract] Collapsing teaser+detail lists: %d → %d (merged open fields into detail)",
                n, half,
            )
            kept = merged_rows

    # Soft dedupe: same 7-digit IMO, or same name+year+dwt+open position.
    # Same name with different year/DWT/position stays as separate rows (sister ships).
    out: list[dict] = []
    by_imo: dict[str, int] = {}
    by_identity: dict[str, int] = {}
    for v in kept:
        imo = re.sub(r"\D", "", _vessel_field(v, "imo", "IMO"))
        ident = _vessel_identity_key(v)
        rich = _vessel_richness(v)
        if len(imo) == 7 and imo in by_imo:
            idx = by_imo[imo]
            if rich >= _vessel_richness(out[idx]):
                out[idx] = _merge_vessel_fields(v, out[idx])
            else:
                out[idx] = _merge_vessel_fields(out[idx], v)
            continue
        if ident and ident != "|||" and ident in by_identity:
            idx = by_identity[ident]
            prev_imo = re.sub(r"\D", "", _vessel_field(out[idx], "imo", "IMO"))
            if len(prev_imo) == 7 and len(imo) != 7:
                out[idx] = _merge_vessel_fields(out[idx], v)
                continue
            if rich >= _vessel_richness(out[idx]):
                out[idx] = _merge_vessel_fields(v, out[idx])
            else:
                out[idx] = _merge_vessel_fields(out[idx], v)
            continue
        idx = len(out)
        out.append(v)
        if len(imo) == 7:
            by_imo[imo] = idx
        if ident and ident != "|||":
            by_identity[ident] = idx

    if len(out) != len(vessels_data):
        logger.info("[Extract] Vessel dedupe %d → %d", len(vessels_data), len(out))
    return out


def _parse_extraction_response(text: str) -> tuple[list[str], list[dict]]:
    """Parse LLM output — new {columns_in_email, vessels} object or legacy array."""
    # Strip markdown code fences
    text = re.sub(r"```(?:json)?\s*", "", text)
    text = re.sub(r"```\s*$", "", text, flags=re.MULTILINE)
    text = text.strip()

    def _from_object(obj: Any) -> tuple[list[str], list[dict]] | None:
        if not isinstance(obj, dict):
            return None
        cols_raw = obj.get("columns_in_email")
        vessels_raw = obj.get("vessels")
        if not isinstance(vessels_raw, list):
            return None
        cols = normalize_columns_in_email(cols_raw if isinstance(cols_raw, list) else None)
        vessels = [v for v in vessels_raw if isinstance(v, dict)]
        return cols, vessels

    # Strategy 1: outermost JSON object
    obj_match = re.search(r"\{.*\}", text, re.DOTALL)
    if obj_match:
        try:
            parsed = json.loads(obj_match.group())
            result = _from_object(parsed)
            if result:
                return result
        except json.JSONDecodeError:
            pass

    # Strategy 2: legacy — plain vessel array
    vessels = _extract_json_array_legacy(text)
    return normalize_columns_in_email(None), vessels


def _extract_json_array_legacy(text: str) -> list[dict]:
    """Robustly pull a JSON array from potentially messy LLM output (legacy format)."""
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


def _load_file_blocks(attachment_id: str, files_meta: list[dict] | None) -> list[dict]:
    """Read the email's stored file attachments and convert them into
    Claude content blocks (images/PDF natively, spreadsheets/Word as text)."""
    if not files_meta:
        return []
    file_dicts: list[dict] = []
    for meta in files_meta:
        stored = meta.get("stored")
        if not stored:
            continue
        try:
            content = read_bytes(attachment_id, stored)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not read attachment file %s/%s: %s", attachment_id, stored, exc)
            continue
        file_dicts.append({
            "filename": meta.get("name") or stored,
            "content_type": meta.get("content_type") or "application/octet-stream",
            "content": content,
        })
    return files_to_content_blocks(file_dicts)


async def _extract_single_attachment(
    job_id: str,
    attachment_id: str,
    filename: str,
    raw_text: str,
    mail_from: str,
    parent_sender: str,
    semaphore: asyncio.Semaphore,
    files_meta: list[dict] | None = None,
    preview_html: str | None = None,
    mail_subject: str = "",
) -> list[dict]:
    """Run Claude on one broker email (body + attachments) and save vessels."""
    async with semaphore:
        # Mark as extracting
        supabase.table("attachments").update({"status": "extracting"}).eq("id", attachment_id).execute()
        await sse_manager.send(job_id, "extraction_started", {
            "attachment_id": attachment_id,
            "filename": filename,
        })

        # Build one user message: prompt text + any image/PDF/doc blocks.
        file_blocks = _load_file_blocks(attachment_id, files_meta)
        body_text = prepare_extraction_text(raw_text, preview_html)
        user_content: list[dict] = [
            {"type": "text", "text": EXTRACTION_PROMPT.format(raw_text=body_text)}
        ]
        user_content.extend(file_blocks)
        if file_blocks:
            logger.info("[Extract] %s — %d attachment block(s) added", filename, len(file_blocks))

        # Retry loop (up to 3 attempts)
        vessels_data: list[dict] = []
        columns_in_email: list[str] = normalize_columns_in_email(None)
        last_error: str = ""
        for attempt in range(1, 4):
            try:
                response = await claude_client.chat.completions.create(
                    model=settings.CLAUDE_MODEL,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "You are a precise shipbroking data extractor. "
                                "Output only valid JSON with columns_in_email and vessels. "
                                "Never extract data from crossed-out or strikethrough text. "
                                "For other_info / EXTRA INFO, include all leftover particulars "
                                "completely — do not shorten them."
                            ),
                        },
                        {
                            "role": "user",
                            "content": user_content,
                        },
                    ],
                    temperature=0.05,
                    max_tokens=8192,
                    timeout=180,  # vision/PDF calls can be slower
                )
                content = response.choices[0].message.content or ""
                columns_in_email, vessels_data = _parse_extraction_response(content)
                vessels_data = collapse_duplicate_vessel_lists(vessels_data)
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

        # Replace prior rows so re-extraction keeps a clean ordered list.
        supabase.table("vessels").delete().eq("attachment_id", attachment_id).execute()

        # One AI company pick per mail (signature + letterhead + LLM candidates).
        llm_companies = []
        for vessel in vessels_data:
            c = str(vessel.get("company") or vessel.get("Company") or "").strip()
            if c:
                llm_companies.append(c)
        ai_company = await pick_owner_company_with_ai(
            raw_text,
            llm_company=llm_companies[0] if llm_companies else "",
            mail_from=mail_from,
            parent_sender=parent_sender,
            mail_subject=mail_subject,
        )

        # Persist each vessel as a separate row (stored in STANDARD schema).
        stored_vessels: list[dict] = []
        for row_order, vessel in enumerate(vessels_data):
            region = vessel.pop("region", None)
            llm_company = str(vessel.pop("company", "") or vessel.pop("Company", "") or "").strip()
            # Normalise keys: lowercase + underscores
            normalised = {k.lower().replace(" ", "_"): str(v) for k, v in vessel.items()}
            normalised["company"] = resolve_vessel_company(
                filename,
                mail_from=mail_from,
                parent_sender=parent_sender,
                raw_text=raw_text,
                mail_subject=mail_subject,
                vessel_name=normalised.get("vessel_name") or "",
                llm_company=llm_company,
                ai_picked_company=ai_company,
            )
            # Map raw LLM keys → the fixed standard columns the grid reads, and
            # normalise the direction value. Done at store time so the grid is
            # correct immediately after a fetch (no server restart needed).
            standardized, reg = map_raw_to_standard(normalised, region)
            mark_bare_dwt_ai_flag(standardized, raw_text)
            mark_bare_year_ai_flag(standardized, raw_text)
            supabase.table("vessels").insert({
                "attachment_id": attachment_id,
                "dynamic_data": standardized,
                "region": reg,
                "row_order": row_order,
            }).execute()
            stored_vessels.append({"dynamic_data": standardized, "region": reg})

        # Keep score checklist in sync with fields actually extracted onto vessels.
        columns_in_email = reconcile_columns_in_email(columns_in_email, stored_vessels)

        supabase.table("attachments").update({
            "status": "done",
            "columns_in_email": columns_in_email,
        }).eq("id", attachment_id).execute()
        await sse_manager.send(job_id, "extraction_done", {
            "attachment_id": attachment_id,
            "filename": filename,
            "vessel_count": len(vessels_data),
            "columns_in_email": columns_in_email,
        })

        if try_auto_verify_attachment(supabase, attachment_id):
            await sse_manager.send(job_id, "attachment_auto_verified", {
                "attachment_id": attachment_id,
                "filename": filename,
            })

        return vessels_data


async def run_extraction(job_id: str, attachment_ids: list[str]) -> int:
    """
    Run extraction on all attachments in parallel (max 10 concurrent).
    Returns total number of vessels extracted.
    """
    if not attachment_ids:
        return 0

    # Fetch attachment metadata
    rows = (
        supabase.table("attachments")
        .select("id, filename, raw_text, preview_html, mail_from, mail_subject, parent_email_id, files")
        .in_("id", attachment_ids)
        .execute()
    )
    attachments = rows.data or []

    parent_ids = list({a.get("parent_email_id") for a in attachments if a.get("parent_email_id")})
    parent_sender: dict[str, str] = {}
    if parent_ids:
        parents = (
            supabase.table("parent_emails")
            .select("id, sender")
            .in_("id", parent_ids)
            .execute()
        ).data or []
        parent_sender = {p["id"]: p.get("sender") or "" for p in parents}

    # Cap concurrency to avoid hammering the API
    semaphore = asyncio.Semaphore(10)

    tasks = [
        _extract_single_attachment(
            job_id,
            att["id"],
            att["filename"],
            att.get("raw_text") or "",
            att.get("mail_from") or "",
            parent_sender.get(att.get("parent_email_id") or "", ""),
            semaphore,
            att.get("files") or [],
            att.get("preview_html") or "",
            att.get("mail_subject") or "",
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
