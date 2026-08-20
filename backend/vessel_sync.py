"""
Bidirectional sync between vessel_library (master particulars) and vessels.dynamic_data.

Shared static fields sync both ways on edit. Position-only fields (opening_date,
open_location, region, cargo history, etc.) stay on the position row only.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from column_defs import map_raw_to_standard
from vessel_library import (
    LIBRARY_FIELDS,
    _find_match,
    _index_library_rows,
    _merge_prefer_incoming,
    _particulars_from_dynamic,
    _clean,
    match_key_from_particulars,
)

logger = logging.getLogger(__name__)

# Library column → vessels.dynamic_data key
LIBRARY_TO_DYNAMIC: dict[str, str] = {
    "vessel_name": "vessel_name",
    "imo_no": "imo",
    "call_sign": "call_sign",
    "vessel_type": "vessel_type",
    "year_built": "year_built",
    "imo_type": "imo_type",
    "dwt": "dwt_sdwt",
    "cbm": "cbm",
    "flag": "flag",
    "sire_date": "sire_date",
    "cdi_date": "cdi_date",
    "tank_coating": "tank_coating",
}


def _parse_dynamic(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
            return dict(data) if isinstance(data, dict) else {}
        except Exception:  # noqa: BLE001
            return {}
    return {}


def _apply_library_to_dynamic(
    dynamic_data: dict[str, Any],
    library_row: dict[str, Any],
    *,
    fields: set[str] | None = None,
    only_empty: bool = False,
) -> tuple[dict[str, Any], list[str]]:
    """Merge library particulars into a position dynamic_data blob."""
    out = dict(dynamic_data)
    changed: list[str] = []
    for lib_field, dyn_key in LIBRARY_TO_DYNAMIC.items():
        if fields is not None and lib_field not in fields:
            continue
        lib_val = _clean(library_row.get(lib_field))
        if not lib_val:
            continue
        cur = _clean(out.get(dyn_key))
        if only_empty and cur:
            continue
        if cur != lib_val:
            out[dyn_key] = lib_val
            changed.append(lib_field)
    return out, changed


def _load_library_index(supabase) -> tuple[dict[str, dict], dict[str, list]]:
    rows = (
        supabase.table("vessel_library")
        .select("id, match_key, " + ", ".join(LIBRARY_FIELDS))
        .execute()
    ).data or []
    return _index_library_rows(rows)


def sync_library_row_to_positions(
    supabase,
    library_row: dict[str, Any],
    *,
    fields: set[str] | None = None,
    only_empty: bool = False,
) -> dict[str, int]:
    """Push library particulars into all matching position-list rows."""
    lib_id = library_row.get("id")
    if not lib_id:
        return {"updated": 0, "checked": 0}

    by_key, by_name = _load_library_index(supabase)
    lib_row = by_key.get(library_row.get("match_key") or "") or library_row
    for rows in by_name.values():
        for r in rows:
            if r.get("id") == lib_id:
                lib_row = r
                break

    vessels = (
        supabase.table("vessels")
        .select("id, dynamic_data, region")
        .execute()
    ).data or []

    updated = 0
    for vessel in vessels:
        dd = _parse_dynamic(vessel.get("dynamic_data"))
        particulars = _particulars_from_dynamic(dd)
        matched = _find_match(particulars, by_key, by_name)
        if not matched or matched.get("id") != lib_id:
            continue

        merged, changed = _apply_library_to_dynamic(
            dd, lib_row, fields=fields, only_empty=only_empty
        )
        if not changed:
            continue

        standardized, reg = map_raw_to_standard(merged, vessel.get("region"))
        supabase.table("vessels").update({
            "dynamic_data": standardized,
            "region": reg,
        }).eq("id", vessel["id"]).execute()
        updated += 1

    if updated:
        logger.info(
            "Library→position sync: library_id=%s updated %d row(s) fields=%s",
            str(lib_id)[:8],
            updated,
            sorted(fields) if fields else "all",
        )
    return {"updated": updated, "checked": len(vessels)}


def backfill_positions_from_library(
    supabase,
    *,
    only_empty: bool = True,
) -> dict[str, int]:
    """Fill empty position fields from the matched library row (one-time / startup)."""
    library_rows = (
        supabase.table("vessel_library")
        .select("id, match_key, " + ", ".join(LIBRARY_FIELDS))
        .execute()
    ).data or []
    total_updated = 0
    vessels_checked = 0
    for lib_row in library_rows:
        stats = sync_library_row_to_positions(
            supabase, lib_row, only_empty=only_empty
        )
        total_updated += stats["updated"]
        vessels_checked = max(vessels_checked, stats["checked"])
    return {"updated": total_updated, "library_rows": len(library_rows), "checked": vessels_checked}


def sync_position_to_library(
    supabase,
    dynamic_data: dict[str, Any],
) -> dict[str, Any] | None:
    """Push edited position particulars into the matching library row (if any)."""
    particulars = _particulars_from_dynamic(dynamic_data or {})
    key = match_key_from_particulars(particulars)
    if not key and not _clean(particulars.get("vessel_name")):
        return None

    existing_rows = (
        supabase.table("vessel_library")
        .select("id, match_key, " + ", ".join(LIBRARY_FIELDS))
        .execute()
    ).data or []
    by_key, by_name = _index_library_rows(existing_rows)
    existing = _find_match(particulars, by_key, by_name)
    if not existing:
        return None

    merged = _merge_prefer_incoming(
        {f: _clean(existing.get(f)) for f in LIBRARY_FIELDS},
        particulars,
    )
    new_key = match_key_from_particulars(merged)
    patch: dict[str, Any] = {}
    for f in LIBRARY_FIELDS:
        if merged.get(f) != _clean(existing.get(f)):
            patch[f] = merged.get(f) or ""
    if new_key and new_key != _clean(existing.get("match_key")):
        patch["match_key"] = new_key
    if not patch:
        return existing

    from datetime import datetime

    patch["updated_at"] = datetime.utcnow()
    result = (
        supabase.table("vessel_library")
        .update(patch)
        .eq("id", existing["id"])
        .execute()
    )
    row = result.data[0] if result.data else {**existing, **patch}
    logger.info(
        "Position→library sync: vessel=%s library_id=%s fields=%s",
        _clean(particulars.get("vessel_name"))[:40],
        str(existing["id"])[:8],
        sorted(k for k in patch if k != "updated_at"),
    )
    return row
