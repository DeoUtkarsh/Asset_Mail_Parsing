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

from column_defs import (
    _looks_like_imo_type,
    _format_rounded_figures,
    _format_dwt_sdwt,
    _format_year_built,
)

logger = logging.getLogger(__name__)

# Columns stored in vessel_library.
LIBRARY_FIELDS = [
    "vessel_name",
    "imo_no",
    "call_sign",
    "vessel_type",
    "year_built",
    "imo_type",
    "dwt",
    "cbm",
    "flag",
    "sire_date",
    "cdi_date",
    "tank_coating",  # kept for autofill / legacy rows (not shown in default UI order)
    "ai_normalized",  # meta: comma-separated fields AI-normalized (e.g. dwt)
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


def _imo_type_from_dynamic(dd: dict) -> str:
    for k in ("imo_type", "imo", "vessel_type"):
        v = dd.get(k)
        if _looks_like_imo_type(v):
            return _clean(v)
    return ""


def _particulars_from_dynamic(dd: dict) -> dict[str, str]:
    """Pull the library fields out of a vessels.dynamic_data blob."""
    imo_type = _imo_type_from_dynamic(dd)
    vessel_type = _clean(dd.get("vessel_type"))
    if _looks_like_imo_type(vessel_type):
        vessel_type = ""
    year = _clean(dd.get("year_built"))
    dwt = _clean(dd.get("dwt_sdwt"))
    cbm = _clean(dd.get("cbm"))
    dwt_fmt, dwt_scaled = _format_dwt_sdwt(dwt) if dwt else ("", False)
    ai_flags: set[str] = set()
    for p in str(dd.get("ai_normalized") or "").split(","):
        p = p.strip()
        if p == "dwt_sdwt":
            ai_flags.add("dwt")
        elif p:
            ai_flags.add(p)
    if dwt_scaled:
        ai_flags.add("dwt")
    return {
        "vessel_name": _clean(dd.get("vessel_name")),
        "imo_no": _imo_number(dd),
        "call_sign": _clean(dd.get("call_sign")),
        "vessel_type": vessel_type,
        "year_built": _format_year_built(year) if year else "",
        "imo_type": imo_type,
        "dwt": dwt_fmt,
        "cbm": _format_rounded_figures(cbm) if cbm else "",
        "flag": _clean(dd.get("flag")),
        "sire_date": _clean(dd.get("sire_date")),
        "cdi_date": _clean(dd.get("cdi_date")),
        "tank_coating": _clean(dd.get("tank_coating")),
        "ai_normalized": ",".join(sorted(ai_flags)),
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

def autofill_library(supabase) -> dict[str, int]:
    """Sync vessel_library from extracted vessels.

    - Inserts vessels not yet in the library (by match_key)
    - Fills blank fields on existing library rows from newer extraction data
    - Re-formats year_built / dwt / cbm on existing rows when needed

    Returns {"inserted": n, "updated": m}.
    """
    candidates = _candidates_from_vessels(supabase)
    existing_rows = (
        supabase.table("vessel_library")
        .select("id, match_key, " + ", ".join(LIBRARY_FIELDS))
        .execute()
    ).data or []
    by_key = {r["match_key"]: r for r in existing_rows if r.get("match_key")}

    inserted = 0
    updated = 0
    for key, particulars in candidates.items():
        if key in by_key:
            row = by_key[key]
            patch: dict[str, Any] = {}
            for f in LIBRARY_FIELDS:
                incoming = particulars.get(f) or ""
                current = _clean(row.get(f))
                if not current and incoming:
                    patch[f] = incoming
                elif f in ("year_built", "dwt", "cbm") and current:
                    preferred = incoming or (
                        _format_year_built(current) if f == "year_built"
                        else (_format_dwt_sdwt(current)[0] if f == "dwt" else _format_rounded_figures(current))
                    )
                    if preferred and preferred != current:
                        patch[f] = preferred
            if patch:
                patch["updated_at"] = datetime.utcnow()
                supabase.table("vessel_library").update(patch).eq("id", row["id"]).execute()
                updated += 1
            continue

        payload = dict(particulars)
        payload["match_key"] = key
        supabase.table("vessel_library").insert(payload).execute()
        inserted += 1

    # Reformat any remaining library rows (including library-only entries).
    updated += normalize_library_formats(supabase)

    if inserted or updated:
        logger.info(
            "Vessel library sync: inserted=%d updated=%d",
            inserted,
            updated,
        )
    return {"inserted": inserted, "updated": updated}


def normalize_library_formats(supabase) -> int:
    """Re-format year_built / dwt / cbm on all vessel_library rows (idempotent)."""
    rows = (
        supabase.table("vessel_library")
        .select("id, year_built, dwt, cbm, ai_normalized")
        .execute()
    ).data or []
    updated = 0
    for row in rows:
        patch: dict[str, Any] = {}
        year = _clean(row.get("year_built"))
        if year:
            fmt = _format_year_built(year)
            if fmt and fmt != year:
                patch["year_built"] = fmt
        dwt = _clean(row.get("dwt"))
        if dwt:
            fmt, scaled = _format_dwt_sdwt(dwt)
            if fmt and fmt != dwt:
                patch["dwt"] = fmt
            flags = {p.strip() for p in _clean(row.get("ai_normalized")).split(",") if p.strip()}
            if scaled:
                flags.add("dwt")
            elif "dwt" not in flags:
                for m in re.finditer(r"[\d,]+(?:\.\d+)?", fmt or dwt):
                    try:
                        n = float(m.group(0).replace(",", ""))
                    except ValueError:
                        continue
                    if n >= 1000 and float(n).is_integer() and int(n) % 1000 == 0:
                        q = int(n) // 1000
                        if 0 < q < 1000:
                            flags.add("dwt")
                            break
            new_flags = ",".join(sorted(flags))
            if new_flags != _clean(row.get("ai_normalized")):
                patch["ai_normalized"] = new_flags
        cbm = _clean(row.get("cbm"))
        if cbm:
            fmt = _format_rounded_figures(cbm)
            if fmt and fmt != cbm:
                patch["cbm"] = fmt
        if patch:
            patch["updated_at"] = datetime.utcnow()
            supabase.table("vessel_library").update(patch).eq("id", row["id"]).execute()
            updated += 1
    if updated:
        logger.info("Normalized formats on %d vessel_library rows", updated)
    return updated


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
    # Only overwrite fields present in the request so omitted legacy columns are kept.
    present = {f: _clean(fields.get(f)) for f in LIBRARY_FIELDS if f in fields}
    vessel_name = present.get("vessel_name")
    imo_no = present.get("imo_no")
    if vessel_name is None or imo_no is None:
        existing = (
            supabase.table("vessel_library")
            .select("vessel_name, imo_no")
            .eq("id", vessel_id)
            .limit(1)
            .execute()
        ).data or []
        if existing:
            vessel_name = vessel_name if vessel_name is not None else existing[0].get("vessel_name", "")
            imo_no = imo_no if imo_no is not None else existing[0].get("imo_no", "")
    payload = dict(present)
    payload["match_key"] = match_key(vessel_name or "", imo_no or "")
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
