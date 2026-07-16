"""
Vessel Library — a deduplicated master list of vessels (static particulars).

Rows are auto-filled from the vessels already extracted into the DB, and can be
managed manually from the UI. "New vessels" are derived on the fly: any vessel
present in position-list data whose match key is not yet in the library.

Dedupe / matching key
---------------------
Two rows are the same vessel when they share an IMO number (7 digits); if a row
has no IMO number we fall back to its normalized vessel name.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

# Columns stored in vessel_library (imo_type is manual-entry, blank on auto-fill).
LIBRARY_FIELDS = [
    "vessel_name",
    "imo_no",
    "imo_type",
    "dwt",
    "year_built",
    "tank_coating",
    "vessel_type",
]

_EMPTY = frozenset({
    "", "-", "—", "–", ".", "..", "n/a", "na", "none", "null", "unknown", "tba", "tbc", "tbd",
})
_IMO_RE = re.compile(r"^\d{7}$")
_IMO_EMBEDDED_RE = re.compile(r"\b(\d{7})\b")
_NAME_PREFIX_RE = re.compile(r"^(?:m\.?\s*[tv]\.?|mv|mt)\s+", re.I)


def _clean(val: Any) -> str:
    s = str(val or "").strip()
    return "" if s.lower() in _EMPTY else s


def _norm_name(name: str) -> str:
    s = _NAME_PREFIX_RE.sub("", _clean(name)).upper()
    s = re.sub(r"[^A-Z0-9 ]+", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _imo_number(dd: dict) -> str:
    raw = _clean(dd.get("imo"))
    if _IMO_RE.match(raw):
        return raw
    m = _IMO_EMBEDDED_RE.search(raw)
    return m.group(1) if m else ""


def match_key(vessel_name: str, imo_no: str) -> str:
    """Stable dedupe key: prefer IMO number, else normalized name."""
    imo = _clean(imo_no)
    if _IMO_RE.match(imo):
        return f"imo:{imo}"
    norm = _norm_name(vessel_name)
    return f"name:{norm}" if norm else ""


def _particulars_from_dynamic(dd: dict) -> dict[str, str]:
    """Pull the library fields out of a vessels.dynamic_data blob."""
    return {
        "vessel_name": _clean(dd.get("vessel_name")),
        "imo_no": _imo_number(dd),
        "imo_type": "",  # manual entry only
        "dwt": _clean(dd.get("dwt_sdwt")),
        "year_built": _clean(dd.get("year_built")),
        "tank_coating": _clean(dd.get("tank_coating")),
        "vessel_type": _clean(dd.get("vessel_type")),
    }


def _merge_into(base: dict[str, str], extra: dict[str, str]) -> None:
    """Fill any blank field in `base` from `extra` (first-non-empty wins)."""
    for f in LIBRARY_FIELDS:
        if not base.get(f) and extra.get(f):
            base[f] = extra[f]


def _candidates_from_vessels(supabase) -> dict[str, dict[str, str]]:
    """One best-merged particulars dict per match key, from all extracted vessels."""
    rows = supabase.table("vessels").select("dynamic_data").execute().data or []
    candidates: dict[str, dict[str, str]] = {}
    for row in rows:
        dd = row.get("dynamic_data") or {}
        particulars = _particulars_from_dynamic(dd)
        key = match_key(particulars["vessel_name"], particulars["imo_no"])
        if not key:
            continue
        if key in candidates:
            _merge_into(candidates[key], particulars)
        else:
            candidates[key] = particulars
    return candidates


def _existing_keys(supabase) -> set[str]:
    rows = supabase.table("vessel_library").select("match_key").execute().data or []
    return {r.get("match_key") for r in rows if r.get("match_key")}


# ── Public operations ────────────────────────────────────────────────────────

def autofill_library(supabase) -> int:
    """Insert deduplicated vessels from the DB into vessel_library (skip existing)."""
    candidates = _candidates_from_vessels(supabase)
    existing = _existing_keys(supabase)
    inserted = 0
    for key, particulars in candidates.items():
        if key in existing:
            continue
        payload = dict(particulars)
        payload["match_key"] = key
        supabase.table("vessel_library").insert(payload).execute()
        inserted += 1
    if inserted:
        logger.info("Vessel library auto-fill: inserted %d vessels", inserted)
    return inserted


def list_library(supabase) -> list[dict[str, Any]]:
    rows = (
        supabase.table("vessel_library")
        .select("id, " + ", ".join(LIBRARY_FIELDS) + ", created_at, updated_at")
        .execute()
    ).data or []
    rows.sort(key=lambda r: (r.get("vessel_name") or "").upper())
    return rows


def detect_new_vessels(supabase) -> list[dict[str, Any]]:
    """Vessels present in position data but not yet in the library."""
    candidates = _candidates_from_vessels(supabase)
    existing = _existing_keys(supabase)
    new_rows: list[dict[str, Any]] = []
    for key, particulars in candidates.items():
        if key in existing:
            continue
        row = dict(particulars)
        row["match_key"] = key
        new_rows.append(row)
    new_rows.sort(key=lambda r: (r.get("vessel_name") or "").upper())
    return new_rows


def _payload_from_fields(fields: dict[str, Any]) -> dict[str, str]:
    return {f: _clean(fields.get(f)) for f in LIBRARY_FIELDS}


def add_library_vessel(supabase, fields: dict[str, Any]) -> dict[str, Any]:
    """Add a vessel (manual entry or promotion from the review list).

    If a row with the same match key already exists, its blank fields are filled
    in and it is returned (prevents duplicates)."""
    payload = _payload_from_fields(fields)
    key = match_key(payload["vessel_name"], payload["imo_no"])
    payload["match_key"] = key

    if key:
        existing = (
            supabase.table("vessel_library")
            .select("id, " + ", ".join(LIBRARY_FIELDS))
            .eq("match_key", key)
            .execute()
        ).data or []
        if existing:
            row = existing[0]
            merged = {f: row.get(f) or payload.get(f, "") for f in LIBRARY_FIELDS}
            merged["updated_at"] = datetime.utcnow()
            result = (
                supabase.table("vessel_library")
                .update(merged)
                .eq("id", row["id"])
                .execute()
            )
            return result.data[0] if result.data else row

    result = supabase.table("vessel_library").insert(payload).execute()
    return result.data[0]


def update_library_vessel(supabase, vessel_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    payload = _payload_from_fields(fields)
    payload["match_key"] = match_key(payload["vessel_name"], payload["imo_no"])
    payload["updated_at"] = datetime.utcnow()
    result = (
        supabase.table("vessel_library")
        .update(payload)
        .eq("id", vessel_id)
        .execute()
    )
    if not result.data:
        raise ValueError("Vessel not found.")
    return result.data[0]


def delete_library_vessel(supabase, vessel_id: str) -> None:
    supabase.table("vessel_library").delete().eq("id", vessel_id).execute()
