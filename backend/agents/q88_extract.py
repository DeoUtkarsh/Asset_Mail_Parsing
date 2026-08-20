"""
Q88 Agent — scans an Intertanko Q88 PDF and returns the FuelSense field set.

Values are stored per vessel_library row (latest PDF only). They do not write
into vessel_library grid columns.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from llm import claude_client, file_to_content_blocks
from config import settings

import pipeline_log as plog

logger = logging.getLogger(__name__)

# (id, q88_ref, label, group, static|dynamic)
Q88_FIELDS: list[tuple[str, str, str, str, str]] = [
    ("imo_number", "1.2", "IMO number", "shared", "static"),
    ("vessel_name", "1.2", "Vessel name", "shared", "dynamic"),
    ("date_delivered", "1.4", "Date delivered", "shared", "static"),
    ("builder", "1.4", "Builder", "shared", "static"),
    ("flag", "1.5", "Flag", "shared", "dynamic"),
    ("port_of_registry", "1.5", "Port of Registry", "shared", "dynamic"),
    ("technical_operator", "1.11", "Technical operator", "shared", "dynamic"),
    ("technical_operator_imo", "1.11", "Technical operator company IMO number", "shared", "dynamic"),
    ("commercial_operator", "1.12", "Commercial operator", "shared", "dynamic"),
    ("loa", "1.27", "Length overall", "shared", "static"),
    ("lbp", "1.28", "Length between perpendiculars", "shared", "static"),
    ("extreme_breadth", "1.29", "Extreme breadth", "shared", "static"),
    ("moulded_depth", "1.30", "Moulded depth", "shared", "static"),
    ("summer_freeboard", "1.39", "Summer freeboard", "shared", "static"),
    ("summer_draft", "1.39", "Summer draft", "shared", "static"),
    ("summer_deadweight", "1.39", "Summer deadweight", "shared", "static"),
    ("summer_displacement", "1.39", "Summer displacement", "shared", "static"),
    ("winter_draft", "1.39", "Winter draft", "shared", "static"),
    ("winter_deadweight", "1.39", "Winter deadweight", "shared", "static"),
    ("tropical_draft", "1.39", "Tropical draft", "shared", "static"),
    ("tropical_deadweight", "1.39", "Tropical deadweight", "shared", "static"),
    ("normal_loaded_draft", "1.39", "Normal loaded draft", "shared", "static"),
    ("normal_loaded_deadweight", "1.39", "Normal loaded deadweight", "shared", "static"),
    ("lightship_draft", "1.39", "Lightship draft", "shared", "static"),
    ("lightship_displacement", "1.39", "Lightship displacement", "shared", "static"),
    ("normal_ballast_draft", "1.39", "Normal ballast draft", "shared", "static"),
    ("normal_ballast_deadweight", "1.39", "Normal ballast deadweight", "shared", "static"),
    ("normal_ballast_displacement", "1.39", "Normal ballast displacement", "shared", "static"),
    ("segregated_ballast_draft", "1.39", "Segregated ballast draft", "shared", "static"),
    ("segregated_ballast_deadweight", "1.39", "Segregated ballast deadweight", "shared", "static"),
    ("fresh_water_allowance", "1.40", "Fresh water allowance", "shared", "static"),
    ("tpc_summer", "1.40", "Tonnes per centimetre at summer draft", "shared", "static"),
    ("ballast_speed_max", "10.1", "Ballast speed - maximum", "shared", "dynamic"),
    ("ballast_speed_econ", "10.1", "Ballast speed - economical", "shared", "dynamic"),
    ("laden_speed_max", "10.1", "Laden speed - maximum", "shared", "dynamic"),
    ("laden_speed_econ", "10.1", "Laden speed - economical", "shared", "dynamic"),
    ("fuel_main", "10.2", "Fuel type - main propulsion", "shared", "dynamic"),
    ("fuel_generating", "10.2", "Fuel type - generating plant", "shared", "dynamic"),
    ("bunker_tank_capacity", "10.3", "Bunker tank capacity", "shared", "static"),
    ("bunker_tank_service", "10.3", "Bunker tank fuel service", "shared", "dynamic"),
    ("bunker_tank_max_pressure", "10.3", "Bunker tank maximum pressure", "shared", "static"),
    ("me_number_power", "10.5", "Main engine - number and rated power", "shared", "static"),
    ("me_make_type", "10.5", "Main engine - make and type", "shared", "static"),
    ("ae_number_power", "10.5", "Auxiliary engine - number and rated power", "shared", "static"),
    ("ae_make_type", "10.5", "Auxiliary engine - make and type", "shared", "static"),
    ("power_packs", "10.5", "Power packs", "shared", "static"),
    ("boiler_number_capacity", "10.5", "Boiler - number and capacity", "shared", "static"),
    ("boiler_make_type", "10.5", "Boiler - make and type", "shared", "static"),
    ("class_society", "1.18", "Classification society", "hull", "dynamic"),
    ("iacs_member", "1.18a", "IACS member", "hull", "dynamic"),
    ("class_notation", "1.19", "Class notation", "hull", "dynamic"),
    ("open_conditions_of_class", "1.20", "Open conditions of class", "hull", "dynamic"),
    ("memoranda_of_class", "1.20a", "Memoranda of class", "hull", "dynamic"),
    ("previous_class", "1.21", "Previous classification society", "hull", "dynamic"),
    ("date_change_class", "1.21", "Date of change of classification society", "hull", "dynamic"),
    ("ice_class", "1.22", "Ice class", "hull", "static"),
    ("last_drydock_date", "1.23", "Last dry-dock date", "hull", "dynamic"),
    ("last_drydock_place", "1.23", "Last dry-dock place", "hull", "dynamic"),
    ("next_drydock_due", "1.24", "Next dry-dock due", "hull", "dynamic"),
    ("next_annual_survey_due", "1.24", "Next annual survey due", "hull", "dynamic"),
    ("last_special_survey", "1.25", "Last special survey", "hull", "dynamic"),
    ("next_special_survey_due", "1.25", "Next special survey due", "hull", "dynamic"),
    ("last_inwater_survey", "1.25a", "Last in-water survey date", "hull", "dynamic"),
    ("next_inwater_survey", "1.25a", "Next in-water survey due", "hull", "dynamic"),
    ("cap_rating", "1.26", "Condition Assessment Program rating", "hull", "dynamic"),
    ("cap_issued_under", "1.26", "Vessel name the CAP rating was issued under", "hull", "dynamic"),
    ("parallel_fwd", "1.34", "Parallel body forward to mid-point manifold", "hull", "static"),
    ("parallel_aft", "1.34", "Parallel body aft to mid-point manifold", "hull", "static"),
    ("parallel_length", "1.34", "Parallel body length", "hull", "static"),
    ("ballast_coating_type", "6.1", "Ballast tank coating type and extent", "hull", "static"),
    ("ballast_coating_date", "6.1", "Ballast tank coating date", "hull", "static"),
    ("ballast_coating_condition", "6.1", "Ballast tank coating condition", "hull", "dynamic"),
    ("ballast_last_inspection", "6.1", "Ballast tank last inspection date", "hull", "dynamic"),
    ("ballast_inspection_freq", "6.1", "Ballast tank inspection frequency", "hull", "static"),
    ("ballast_anodes", "6.1", "Ballast tank anodes fitted", "hull", "static"),
    ("ballast_pump_number_type", "7.1", "Ballast pump number and type", "hull", "static"),
    ("ballast_pump_capacity", "7.1", "Ballast pump capacity", "hull", "static"),
    ("ballast_pump_head", "7.1", "Ballast pump head", "hull", "static"),
    ("heat_exchanger_tanks", "8.27", "Heat exchanger tanks", "hull", "static"),
    ("heating_coil_tanks", "8.27", "Heating coil tanks", "hull", "static"),
    ("heating_coil_height", "8.27", "Heating coil height above tank bottom", "hull", "static"),
    ("total_heating_surface", "8.27", "Total heating surface", "hull", "static"),
    ("ratio_heating_surface", "8.27", "Ratio of heating surface", "hull", "static"),
    ("cargo_pumps_simultaneous", "8.31", "Cargo pumps that can run simultaneously at full capacity", "hull", "static"),
    ("cargo_pump_cap_cot", "8.32", "Cargo pump capacity - COT 1 to 6 W", "hull", "static"),
    ("cargo_pump_head_cot", "8.32", "Cargo pump head - COT 1 to 6 W", "hull", "static"),
    ("cargo_pump_cap_slop", "8.32", "Cargo pump capacity - slop", "hull", "static"),
    ("cargo_pump_head_slop", "8.32", "Cargo pump head - slop", "hull", "static"),
    ("propeller_type", "10.4", "Propeller type", "hull", "static"),
    ("bow_thruster_bhp", "10.6", "Bow thruster brake horse power", "hull", "static"),
    ("stern_thruster_bhp", "10.7", "Stern thruster brake horse power", "hull", "static"),
    ("registered_owner", "1.10", "Registered owner", "emissions", "dynamic"),
    ("registered_owner_imo", "1.10", "Registered owner IMO number", "emissions", "dynamic"),
    ("disponent_owner", "1.13", "Disponent owner", "emissions", "dynamic"),
    ("net_tonnage", "1.35", "Net tonnage", "emissions", "static"),
    ("gross_tonnage", "1.36", "Gross tonnage", "emissions", "static"),
    ("suez_gt", "1.37", "Suez Canal gross tonnage", "emissions", "static"),
    ("suez_nt", "1.37", "Suez Canal net tonnage", "emissions", "static"),
    ("panama_nt", "1.38", "Panama Canal net tonnage", "emissions", "static"),
    ("doc_issued", "2.10", "Document of Compliance issued", "emissions", "dynamic"),
    ("doc_expires", "2.10", "Document of Compliance expires", "emissions", "dynamic"),
    ("ieec_issued", "2.20", "International Energy Efficiency Certificate issued", "emissions", "dynamic"),
    ("ieec_expires", "2.20", "International Energy Efficiency Certificate expires", "emissions", "dynamic"),
    ("iapp_issued", "2.21", "International Air Pollution Prevention Certificate issued", "emissions", "dynamic"),
    ("iapp_last_annual", "2.21", "International Air Pollution Prevention Certificate last annual", "emissions", "dynamic"),
    ("iapp_expires", "2.21", "International Air Pollution Prevention Certificate expires", "emissions", "dynamic"),
    ("iopp_issued", "2.5", "International Oil Pollution Prevention Certificate issued", "emissions", "dynamic"),
    ("iopp_last_annual", "2.5", "International Oil Pollution Prevention Certificate last annual", "emissions", "dynamic"),
    ("iopp_expires", "2.5", "International Oil Pollution Prevention Certificate expires", "emissions", "dynamic"),
    ("eedi_rating", "10.8", "EEDI rating", "emissions", "static"),
    ("eedi_exemption", "10.8", "EEDI exemption reason", "emissions", "static"),
    ("eedi_verification", "10.8", "EEDI verification body", "emissions", "static"),
    ("eexi_rating", "10.9", "EEXI rating", "emissions", "static"),
    ("eexi_verification", "10.9", "EEXI verification body", "emissions", "static"),
    ("cii_rating", "10.10", "CII rating", "emissions", "dynamic"),
    ("cii_verification", "10.10", "CII verification body", "emissions", "dynamic"),
    ("eiv_rating", "10.11", "EIV rating", "emissions", "static"),
    ("nox_level", "10.12", "NOx control level", "emissions", "static"),
    ("tier3_equipment", "10.12", "Tier III equipment fitted", "emissions", "static"),
    ("egcs_used", "10.13", "Exhaust Gas Cleaning System used", "emissions", "dynamic"),
    ("scrubber_type", "10.14", "Scrubber type", "emissions", "dynamic"),
    ("ukc_policy", "1.43", "Under keel clearance policy", "secondary", "dynamic"),
]

GROUP_LABELS = {
    "shared": "Shared vessel master",
    "hull": "Hull and machinery",
    "emissions": "Emissions and compliance",
    "secondary": "Secondary context",
}

Q88_AGENT_SYSTEM = """\
You are the Q88 Scan Agent for a shipbroker workspace.

Your job: read the attached Intertanko Q88 PDF (usually Version 6) page by page and
extract structured field values for downstream FuelSense agents.

Rules:
- Scan the whole document — every section, table, certificate block, and footnote.
- Map certificates by their full name when question numbers differ between forms.
- If a field is blank, not printed, or "Not stated" / "Not applicable", return "".
- Never invent values. Copy text faithfully from the form.
- When one Q88 line packs two answers, split them into separate field ids if needed.
- Return ONLY valid JSON — no markdown fences, no commentary.
"""

Q88_AGENT_USER = """\
Scan this Q88 PDF: {filename}

Return JSON in exactly this shape:
{{ "values": {{ "<field_id>": "<string value>" }} }}

Extract every field id below. Use "" when absent on this form.

FIELD CATALOG:
{catalog}
"""


def _field_catalog() -> str:
    lines: list[str] = []
    cur_group = ""
    for fid, ref, label, group, kind in Q88_FIELDS:
        if group != cur_group:
            cur_group = group
            lines.append(f"\n[{GROUP_LABELS.get(group, group)}]")
        lines.append(f"  {fid}  (Q88 {ref}, {kind})  {label}")
    return "\n".join(lines).strip()


def _norm_imo(raw: str) -> str:
    digits = re.sub(r"\D", "", raw or "")
    return digits[-7:] if len(digits) >= 7 else digits


def _norm_name(raw: str) -> str:
    s = (raw or "").upper()
    s = re.sub(r"\b(M/?T|M/?V|MT|MV)\b", " ", s)
    s = re.sub(r"[^A-Z0-9]+", " ", s)
    return " ".join(s.split())


def _parse_obj(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {}
    cleaned = re.sub(r"```(?:json)?", "", text).replace("```", "").strip()
    try:
        data = json.loads(cleaned)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", cleaned)
        if not m:
            return {}
        try:
            data = json.loads(m.group(0))
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}


def empty_field_rows() -> list[dict[str, str]]:
    return [
        {
            "id": fid,
            "q88_ref": ref,
            "name": label,
            "group": group,
            "kind": kind,
            "value": "",
        }
        for fid, ref, label, group, kind in Q88_FIELDS
    ]


def merge_values(values: dict[str, Any]) -> list[dict[str, str]]:
    rows = empty_field_rows()
    for row in rows:
        raw = values.get(row["id"])
        if raw is None:
            continue
        row["value"] = str(raw).strip()
    return rows


def mismatch_against_library(
    fields: list[dict[str, str]],
    library_name: str,
    library_imo: str,
) -> dict[str, Any]:
    by_id = {r["id"]: (r.get("value") or "") for r in fields}
    pdf_imo = _norm_imo(by_id.get("imo_number") or "")
    lib_imo = _norm_imo(library_imo)
    pdf_name = _norm_name(by_id.get("vessel_name") or "")
    lib_name = _norm_name(library_name)
    imo_clash = bool(pdf_imo and lib_imo and pdf_imo != lib_imo)
    name_clash = bool(pdf_name and lib_name and pdf_name != lib_name)
    return {
        "mismatch": imo_clash or name_clash,
        "pdf_imo": by_id.get("imo_number") or "",
        "pdf_name": by_id.get("vessel_name") or "",
        "library_imo": library_imo or "",
        "library_name": library_name or "",
    }


async def extract_q88_pdf(raw: bytes, filename: str) -> list[dict[str, str]]:
    """Q88 Scan Agent — vision-read the PDF and return merged field rows."""
    with plog.step("Q88", "Agent scanning PDF", file=filename, bytes=len(raw), model=settings.CLAUDE_MODEL):
        blocks = file_to_content_blocks({
            "filename": filename,
            "content_type": "application/pdf",
            "content": raw,
        })
        if not blocks:
            raise ValueError("Could not read this PDF.")

        user_content: list[Any] = list(blocks)
        user_content.append({
            "type": "text",
            "text": Q88_AGENT_USER.format(
                filename=filename,
                catalog=_field_catalog(),
            ),
        })

        plog.info("Q88", "Claude reading Q88 form pages…", file=filename)
        resp = await claude_client.chat.completions.create(
            model=settings.CLAUDE_MODEL,
            temperature=0,
            max_tokens=8192,
            timeout=180.0,
            messages=[
                {"role": "system", "content": Q88_AGENT_SYSTEM},
                {"role": "user", "content": user_content},
            ],
        )
        text = (resp.choices[0].message.content or "").strip()
        data = _parse_obj(text)
        values = data.get("values") if isinstance(data.get("values"), dict) else data
        if not isinstance(values, dict):
            values = {}

    rows = merge_values(values)
    filled = sum(1 for r in rows if r["value"])
    imo = next((r["value"] for r in rows if r["id"] == "imo_number"), "")
    name = next((r["value"] for r in rows if r["id"] == "vessel_name"), "")
    plog.info("Q88", "Scan result", file=filename, filled=f"{filled}/{len(rows)}", imo=imo, name=name)
    if filled == 0:
        plog.warn("Q88", "No fields extracted", file=filename)
    return rows
