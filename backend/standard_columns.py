"""
Fixed vessel grid columns — shared by API, drafter, and frontend display.
Mirrors frontend/src/utils/standardColumns.js
"""
from __future__ import annotations

import re
from typing import Any

EMPTY_VALUES = frozenset({
    "", "-", "—", "–", ".", "..", "n/a", "na", "none", "null", "unknown", "tba", "tbc", "tbd",
})

STANDARD_COLUMNS: list[dict[str, Any]] = [
    {"id": "_num", "header": "SR. NO"},
    {"id": "imo", "header": "IMO"},
    {"id": "vessel_name", "header": "VESSEL NAME"},
    {"id": "call_sign", "header": "CALL SIGN"},
    {"id": "year_built", "header": "YEAR BUILT"},
    {"id": "vessel_type", "header": "VESSEL TYPE"},
    {"id": "cargo_type", "header": "CARGO TYPE"},
    {"id": "dwt_sdwt", "header": "DWT/SDWT"},
    {"id": "cbm", "header": "CBM/CUBIC METER"},
    {"id": "draft", "header": "DRAFT"},
    {"id": "flag", "header": "FLAG"},
    {"id": "region", "header": "REGION"},
    {"id": "open_location", "header": "OPEN LOCATION"},
    {"id": "opening_date", "header": "OPENING DATE"},
    {"id": "cargo_history_combo", "header": "CARGO HISTORY/L3C/LAST 3 CARGOES"},
    {"id": "tank_coating", "header": "TANK COATING"},
    {"id": "sire_date", "header": "SIRE DATE"},
    {"id": "sire_location", "header": "SIRE LOCATION"},
    {"id": "cdi_date", "header": "CDI DATE"},
    {"id": "cdi_location", "header": "CDI LOCATION"},
    {"id": "remarks", "header": "REMARKS"},
    {"id": "other_info", "header": "OTHER INFO"},
    {"id": "q88", "header": "Q88 AVAILABLE"},
    {"id": "attachments", "header": "ATTACHMENTS"},
    {"id": "status", "header": "STATUS"},
]

STANDARD_COLUMN_IDS = [c["id"] for c in STANDARD_COLUMNS]

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
    for k in ("imo_number", "imo"):
        v = str(dd.get(k) or "").strip()
        if IMO_NUMBER_RE.match(v):
            return v
    for k in ("imo_number", "imo"):
        v = str(dd.get(k) or "").strip()
        m = IMO_EMBEDDED_RE.search(v)
        if m:
            return m.group(1)
    return ""


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


def _resolve_misplaced_imo_type(dd: dict) -> str:
    for k in ("imo", "imo_number"):
        v = dd.get(k)
        if _looks_like_imo_type(v):
            return str(v).strip()
    return ""


def _resolve_vessel_type(dd: dict) -> str:
    primary = _first_hit(dd, ["vessel_type", "type", "imo_type", "tank_type"])
    if primary:
        return primary
    return _resolve_misplaced_imo_type(dd)


def _resolve_open_fields(dd: dict) -> tuple[str, str]:
    open_used: str | None = None
    location = ""
    for k in ("port_name", "position", "area", "open"):
        v = dd.get(k)
        if _has_value(v):
            location = str(v).strip()
            if k == "open":
                open_used = "location"
            break
    date = ""
    for k in ("open_date", "when", "dates", "open"):
        if k == "open" and open_used == "location":
            continue
        v = dd.get(k)
        if _has_value(v):
            date = str(v).strip()
            break
    return location, date


def _resolve_dwt_sdwt(dd: dict) -> str:
    dwt = _first_hit(dd, ["dwt"])
    sdwt = _first_hit(dd, ["sdwt", "deadweight"])
    if dwt and sdwt:
        return f"{dwt} / {sdwt}"
    return dwt or sdwt


def _resolve_cargo_history(dd: dict) -> str:
    parts: list[str] = []
    for k in (
        "cargo_history", "l3c", "last_3_cargoes", "last_3_cargos", "last_3_cgo", "last_cargo_s",
    ):
        v = dd.get(k)
        if _has_value(v):
            parts.append(str(v).strip())
    return " / ".join(parts)


def resolve_cell_value(vessel: dict, column_id: str, row_num: int = 1) -> str:
    dd = vessel.get("dynamic_data") or {}

    if column_id == "_num":
        return str(row_num)
    if column_id == "imo":
        return _extract_imo_number(dd)
    if column_id == "call_sign":
        return _first_hit(dd, ["call_sign"])
    if column_id == "vessel_name":
        return _first_hit(dd, ["vessel_name", "name"])
    if column_id == "year_built":
        return _first_hit(dd, ["built", "yard_built", "when"])
    if column_id == "vessel_type":
        return _resolve_vessel_type(dd)
    if column_id == "cargo_type":
        return _first_hit(dd, ["grade", "last_cargo", "cargo_preference"])
    if column_id == "dwt_sdwt":
        return _resolve_dwt_sdwt(dd)
    if column_id == "cbm":
        return _first_hit(dd, ["cbm", "cubic", "cub", "cargo_tank_capacity", "total_cargo_tank_capacities_m3_98"])
    if column_id == "draft":
        return _first_hit(dd, ["draft", "sdraft", "sdwt_draft"])
    if column_id == "flag":
        return _first_hit(dd, ["flag"])
    if column_id == "region":
        return str(vessel.get("region") or "").strip()
    if column_id == "open_location":
        return _resolve_open_fields(dd)[0]
    if column_id == "opening_date":
        return _resolve_open_fields(dd)[1]
    if column_id == "cargo_history_combo":
        return _resolve_cargo_history(dd)
    if column_id == "tank_coating":
        return _first_hit(dd, ["tank_coating", "coating", "coat"])
    if column_id == "sire_date":
        return _first_hit(dd, ["sire_date", "sire"])
    if column_id == "sire_location":
        return _first_hit(dd, ["sire_location"])
    if column_id == "cdi_date":
        return _first_hit(dd, ["cdi_date", "cdi"])
    if column_id == "cdi_location":
        return _first_hit(dd, ["cdi_location"])
    if column_id == "remarks":
        return _first_hit(dd, ["remarks", "remark", "comments", "comment"])
    if column_id == "other_info":
        return ""
    if column_id == "q88":
        return _first_hit(dd, ["q88"])
    if column_id == "attachments":
        fn = str(vessel.get("filename") or "")
        return fn[:-4] if fn.lower().endswith(".eml") else fn
    if column_id == "status":
        return _first_hit(dd, ["status", "open_status"])
    return str(dd.get(column_id) or "").strip()


def header_for_column(column_id: str) -> str:
    for c in STANDARD_COLUMNS:
        if c["id"] == column_id:
            return c["header"]
    return column_id.replace("_", " ").upper()
