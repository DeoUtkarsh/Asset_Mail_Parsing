"""
Column definitions (PostgreSQL source of truth) and legacy → standard field mapping.
"""
from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

EMPTY_VALUES = frozenset({
    "", "-", "—", "–", ".", "..", "n/a", "na", "none", "null", "unknown", "tba", "tbc", "tbd",
})

# Keys stored in vessels.dynamic_data (region is vessels.region column).
STANDARD_DYNAMIC_KEYS: list[str] = [
    "imo",
    "vessel_name",
    "call_sign",
    "year_built",
    "vessel_type",
    "cargo_type",
    "dwt_sdwt",
    "cbm",
    "draft",
    "flag",
    "eta_foc",
    "open_location",
    "opening_date",
    "cargo_history_combo",
    "tank_coating",
    "sire_date",
    "sire_location",
    "cdi_date",
    "cdi_location",
    "remarks",
    "other_info",
    "q88",
    "status",
]

LEGACY_KEY_HINTS = frozenset({
    "dwt", "sdwt", "deadweight", "built", "yard_built", "when", "coating", "coat",
    "last_cargo", "cargo_preference", "grade", "last_3_cargoes", "last_3_cargos",
    "last_3_cgo", "last_cargo_s", "l3c", "cargo_history", "open_date", "dates",
    "port_name", "position", "area", "open", "name", "type", "imo_type", "tank_type",
    "cubic", "cub", "cargo_tank_capacity", "remark", "comments", "comment", "remarks",
    "sire", "cdi", "open_status", "imo_number", "sdraft", "sdwt_draft", "region",
    "eta_foc", "eta foc", "eta_foc:",
})

DEFAULT_COLUMN_DEFINITIONS: list[dict[str, Any]] = [
    {"id": "_num", "header": "SR. NO", "display_order": 0, "read_only": True, "storage": "derived"},
    {"id": "imo", "header": "IMO", "display_order": 1, "read_only": False, "storage": "dynamic_data"},
    {"id": "vessel_name", "header": "VESSEL NAME", "display_order": 2, "read_only": False, "storage": "dynamic_data"},
    {"id": "call_sign", "header": "CALL SIGN", "display_order": 3, "read_only": False, "storage": "dynamic_data"},
    {"id": "year_built", "header": "YEAR BUILT", "display_order": 4, "read_only": False, "storage": "dynamic_data"},
    {"id": "vessel_type", "header": "VESSEL TYPE", "display_order": 5, "read_only": False, "storage": "dynamic_data"},
    {"id": "cargo_type", "header": "CARGO TYPE", "display_order": 6, "read_only": False, "storage": "dynamic_data"},
    {"id": "dwt_sdwt", "header": "DWT/SDWT", "display_order": 7, "read_only": False, "storage": "dynamic_data"},
    {"id": "cbm", "header": "CBM/CUBIC METER", "display_order": 8, "read_only": False, "storage": "dynamic_data"},
    {"id": "draft", "header": "DRAFT", "display_order": 9, "read_only": False, "storage": "dynamic_data"},
    {"id": "flag", "header": "FLAG", "display_order": 10, "read_only": False, "storage": "dynamic_data"},
    {"id": "eta_foc", "header": "ETA FOC", "display_order": 11, "read_only": False, "storage": "dynamic_data"},
    {"id": "region", "header": "REGION", "display_order": 12, "read_only": False, "storage": "region"},
    {"id": "open_location", "header": "OPEN LOCATION", "display_order": 13, "read_only": False, "storage": "dynamic_data"},
    {"id": "opening_date", "header": "OPENING DATE", "display_order": 14, "read_only": False, "storage": "dynamic_data"},
    {"id": "cargo_history_combo", "header": "CARGO HISTORY/L3C/LAST 3 CARGOES", "display_order": 15, "read_only": False, "storage": "dynamic_data"},
    {"id": "tank_coating", "header": "TANK COATING", "display_order": 16, "read_only": False, "storage": "dynamic_data"},
    {"id": "sire_date", "header": "SIRE DATE", "display_order": 17, "read_only": False, "storage": "dynamic_data"},
    {"id": "sire_location", "header": "SIRE LOCATION", "display_order": 18, "read_only": False, "storage": "dynamic_data"},
    {"id": "cdi_date", "header": "CDI DATE", "display_order": 19, "read_only": False, "storage": "dynamic_data"},
    {"id": "cdi_location", "header": "CDI LOCATION", "display_order": 20, "read_only": False, "storage": "dynamic_data"},
    {"id": "remarks", "header": "REMARKS", "display_order": 21, "read_only": False, "storage": "dynamic_data"},
    {"id": "other_info", "header": "OTHER INFO", "display_order": 22, "read_only": True, "storage": "dynamic_data"},
    {"id": "q88", "header": "Q88 AVAILABLE", "display_order": 23, "read_only": False, "storage": "dynamic_data"},
    {"id": "attachments", "header": "ATTACHMENTS", "display_order": 24, "read_only": True, "storage": "derived"},
    {"id": "status", "header": "STATUS", "display_order": 25, "read_only": False, "storage": "dynamic_data"},
]

IMO_NUMBER_RE = re.compile(r"^\d{7}$")
IMO_EMBEDDED_RE = re.compile(r"\b(\d{7})\b")


def _has_value(val: Any) -> bool:
    if val is None:
        return False
    s = str(val).strip()
    if not s or s.lower() in EMPTY_VALUES:
        return False
    if all(c in "-–—." for c in s):
        return False
    return True


def _first_hit(dd: dict, keys: list[str]) -> str:
    for k in keys:
        v = dd.get(k)
        if _has_value(v):
            return str(v).strip()
    return ""


def _extract_imo_number(dd: dict) -> str:
    if _has_value(dd.get("imo")) and IMO_NUMBER_RE.match(str(dd["imo"]).strip()):
        return str(dd["imo"]).strip()
    for k in ("imo_number", "imo"):
        v = str(dd.get(k) or "").strip()
        if IMO_NUMBER_RE.match(v):
            return v
    for k in ("imo_number", "imo"):
        v = str(dd.get(k) or "").strip()
        m = IMO_EMBEDDED_RE.search(v)
        if m:
            return m.group(1)
    return _first_hit(dd, ["imo"])


def _looks_like_imo_type(val: Any) -> bool:
    if not _has_value(val):
        return False
    s = str(val).strip()
    if IMO_NUMBER_RE.match(s):
        return False
    norm = re.sub(r"\s+", "", s.lower())
    if re.match(r"^imo[\d/]+", norm):
        return True
    if re.match(r"^\d(/\d)?$", norm):
        return True
    if re.match(r"^(i{1,3}|ii|iii|iv)(/(i{1,3}|ii|iii|iv))?$", norm):
        return True
    return False


def _resolve_vessel_type(dd: dict) -> str:
    if _has_value(dd.get("vessel_type")):
        return str(dd["vessel_type"]).strip()
    primary = _first_hit(dd, ["vessel_type", "type", "imo_type", "tank_type"])
    if primary:
        return primary
    for k in ("imo", "imo_number"):
        v = dd.get(k)
        if _looks_like_imo_type(v):
            return str(v).strip()
    return ""


def _resolve_open_fields(dd: dict) -> tuple[str, str]:
    if _has_value(dd.get("open_location")):
        loc = str(dd["open_location"]).strip()
    else:
        open_used = None
        loc = ""
        for k in ("port_name", "position", "area", "open"):
            v = dd.get(k)
            if _has_value(v):
                loc = str(v).strip()
                if k == "open":
                    open_used = "location"
                break
    if _has_value(dd.get("opening_date")):
        return loc, str(dd["opening_date"]).strip()
    open_used = None
    date = ""
    for k in ("open_date", "when", "dates", "open"):
        if k == "open" and open_used == "location":
            continue
        v = dd.get(k)
        if _has_value(v):
            date = str(v).strip()
            break
    return loc, date


def _resolve_dwt_sdwt(dd: dict) -> str:
    if _has_value(dd.get("dwt_sdwt")):
        return str(dd["dwt_sdwt"]).strip()
    dwt = _first_hit(dd, ["dwt"])
    sdwt = _first_hit(dd, ["sdwt", "deadweight"])
    if dwt and sdwt:
        return f"{dwt} / {sdwt}"
    return dwt or sdwt


def _resolve_cargo_history(dd: dict) -> str:
    if _has_value(dd.get("cargo_history_combo")):
        return str(dd["cargo_history_combo"]).strip()
    parts: list[str] = []
    for k in (
        "cargo_history", "l3c", "last_3_cargoes", "last_3_cargos", "last_3_cgo", "last_cargo_s",
    ):
        v = dd.get(k)
        if _has_value(v):
            parts.append(str(v).strip())
    return " / ".join(parts)


def empty_standard_dynamic_data() -> dict[str, str]:
    return {k: "" for k in STANDARD_DYNAMIC_KEYS}


def needs_migration(dd: dict | None) -> bool:
    """True when dynamic_data is not exactly the standard keys."""
    if not dd:
        return False
    return set(dd.keys()) != set(STANDARD_DYNAMIC_KEYS)


def map_raw_to_standard(dd: dict | None, region: str | None = None) -> tuple[dict[str, str], str]:
    """Map legacy or partial LLM output into the standard dynamic_data keys."""
    src = dd or {}

    if not needs_migration(src):
        out = {k: str(src.get(k, "") or "").strip() for k in STANDARD_DYNAMIC_KEYS}
        reg = (region or _first_hit(src, ["region"]) or "").strip()
        return out, reg

    loc, date = _resolve_open_fields(src)
    out: dict[str, str] = {
        "imo": _extract_imo_number(src),
        "vessel_name": _first_hit(src, ["vessel_name", "name"]),
        "call_sign": _first_hit(src, ["call_sign"]),
        "year_built": _first_hit(src, ["year_built", "built", "yard_built", "when"]),
        "vessel_type": _resolve_vessel_type(src),
        "cargo_type": _first_hit(src, ["cargo_type", "grade", "last_cargo", "cargo_preference"]),
        "dwt_sdwt": _resolve_dwt_sdwt(src),
        "cbm": _first_hit(src, ["cbm", "cubic", "cub", "cargo_tank_capacity"]),
        "draft": _first_hit(src, ["draft", "sdraft", "sdwt_draft"]),
        "flag": _first_hit(src, ["flag"]),
        "eta_foc": _first_hit(src, ["eta_foc", "eta foc"]),
        "open_location": loc,
        "opening_date": date,
        "cargo_history_combo": _resolve_cargo_history(src),
        "tank_coating": _first_hit(src, ["tank_coating", "coating", "coat"]),
        "sire_date": _first_hit(src, ["sire_date", "sire"]),
        "sire_location": _first_hit(src, ["sire_location"]),
        "cdi_date": _first_hit(src, ["cdi_date", "cdi"]),
        "cdi_location": _first_hit(src, ["cdi_location"]),
        "remarks": _first_hit(src, ["remarks", "remark", "comments", "comment"]),
        "other_info": _first_hit(src, ["other_info"]),
        "q88": _first_hit(src, ["q88"]),
        "status": _first_hit(src, ["status", "open_status"]),
    }

    reg = (region or _first_hit(src, ["region"]) or loc or "").strip()
    if not reg:
        reg = "UNSPECIFIED"
    return out, reg


def ensure_column_definitions(supabase) -> None:
    """Seed column_definitions when empty (first install)."""
    existing = supabase.table("column_definitions").select("id").limit(1).execute()
    if existing.data:
        return
    for col in DEFAULT_COLUMN_DEFINITIONS:
        supabase.table("column_definitions").insert(dict(col)).execute()
    logger.info("Seeded %d column_definitions rows", len(DEFAULT_COLUMN_DEFINITIONS))


def sync_column_definitions(supabase) -> None:
    """Insert missing columns and refresh display_order from DEFAULT_COLUMN_DEFINITIONS."""
    rows = supabase.table("column_definitions").select("id").execute()
    existing_ids = {r["id"] for r in (rows.data or [])}
    if not existing_ids:
        ensure_column_definitions(supabase)
        return
    for col in DEFAULT_COLUMN_DEFINITIONS:
        payload = dict(col)
        if payload["id"] in existing_ids:
            supabase.table("column_definitions").update({
                "header": payload["header"],
                "display_order": payload["display_order"],
                "read_only": payload["read_only"],
                "storage": payload["storage"],
            }).eq("id", payload["id"]).execute()
        else:
            supabase.table("column_definitions").insert(payload).execute()
    logger.info("Synced %d column_definitions rows", len(DEFAULT_COLUMN_DEFINITIONS))


def migrate_all_vessel_rows(supabase) -> int:
    rows = supabase.table("vessels").select("id, dynamic_data, region").execute()
    updated = 0
    for vessel in rows.data or []:
        dd = vessel.get("dynamic_data") or {}
        standardized, reg = map_raw_to_standard(dd, vessel.get("region"))
        payload: dict[str, Any] = {"dynamic_data": standardized, "region": reg}
        if standardized == dd and reg == (vessel.get("region") or ""):
            continue
        supabase.table("vessels").update(payload).eq("id", vessel["id"]).execute()
        updated += 1
    if updated:
        logger.info("Migrated %d vessel rows to standard column schema", updated)
    return updated


def get_column_definitions(supabase) -> list[dict[str, Any]]:
    rows = (
        supabase.table("column_definitions")
        .select("id, header, display_order, read_only, storage")
        .order("display_order")
        .execute()
    )
    return rows.data or DEFAULT_COLUMN_DEFINITIONS.copy()


def get_column_ids(supabase) -> list[str]:
    return [c["id"] for c in get_column_definitions(supabase)]


def resolve_cell_value(vessel: dict, column_id: str, row_num: int = 1) -> str:
    if column_id == "_num":
        return str(row_num)
    if column_id == "region":
        return str(vessel.get("region") or "").strip()
    if column_id == "attachments":
        fn = str(vessel.get("filename") or "")
        return fn[:-4] if fn.lower().endswith(".eml") else fn
    dd = vessel.get("dynamic_data") or {}
    return str(dd.get(column_id) or "").strip()


def header_for_column(column_id: str, columns: list[dict] | None = None) -> str:
    cols = columns or DEFAULT_COLUMN_DEFINITIONS
    for c in cols:
        if c["id"] == column_id:
            return c["header"]
    return column_id.replace("_", " ").upper()
