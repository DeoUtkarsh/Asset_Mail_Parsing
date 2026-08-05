"""
Vessel Library — a deduplicated master list of vessels (static particulars).

Rows are auto-filled from the vessels already extracted into the DB, and can be
managed manually from the UI. "New vessels" are derived on the fly: any vessel
present in position-list data whose match key is not yet in the library.

Dedupe / matching
-----------------
1. IMO number (7 digits) — strongest identity.
2. Else composite of normalized name (MT/MV/M/T/M/V stripped) plus any of
   year_built, dwt, vessel_type, imo_type that are present.
3. Soft match: same normalized name with no conflicting particulars merges
   into one row (e.g. name-only mail updates a name+year library row).

Match → upsert (non-empty incoming values overwrite). No match → insert.
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
    _normalize_vessel_name_case,
    _normalize_vessel_type_case,
    title_case_text,
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

_IDENTITY_FIELDS = ("year_built", "dwt", "vessel_type", "imo_type", "imo_no")

_EMPTY = frozenset({
    "", "-", "—", "–", ".", "..", "n/a", "na", "none", "null", "unknown", "tba", "tbc", "tbd",
})
_IMO_RE = re.compile(r"^\d{7}$")
_IMO_EMBEDDED_RE = re.compile(r"\b(\d{7})\b")
# MT / MV / M/T / M/V / M.T. / M.V. prefixes
_NAME_PREFIX_RE = re.compile(r"^(?:m\s*/\s*[tv]|m\.?\s*[tv]\.?|mv|mt)\s+", re.I)


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


def _norm_year(val: str) -> str:
    s = _clean(val)
    if not s:
        return ""
    fmt, _ = _format_year_built(s)
    digits = re.sub(r"\D", "", fmt or s)
    if len(digits) == 4:
        return digits
    if len(digits) == 2:
        n = int(digits)
        return str(2000 + n if n < 50 else 1900 + n)
    return digits or s.upper()


def _norm_dwt(val: str) -> str:
    s = _clean(val)
    if not s:
        return ""
    fmt, _, _ = _format_dwt_sdwt(s)
    m = re.search(r"[\d,]+(?:\.\d+)?", fmt or s)
    if not m:
        return re.sub(r"\s+", "", s.upper())
    try:
        n = float(m.group(0).replace(",", ""))
        return str(int(n)) if float(n).is_integer() else str(n)
    except ValueError:
        return m.group(0).replace(",", "")


def _norm_type(val: str) -> str:
    s = _clean(val)
    if not s:
        return ""
    return re.sub(r"[^A-Z0-9]+", "", s.upper())


def match_key(
    vessel_name: str,
    imo_no: str,
    *,
    year_built: str = "",
    dwt: str = "",
    vessel_type: str = "",
    imo_type: str = "",
) -> str:
    """Stable dedupe key: IMO first, else name + available particulars."""
    imo = _clean(imo_no)
    if _IMO_RE.match(imo):
        return f"imo:{imo}"
    norm = _norm_name(vessel_name)
    if not norm:
        return ""
    parts = [f"name:{norm}"]
    y = _norm_year(year_built)
    if y:
        parts.append(f"year:{y}")
    d = _norm_dwt(dwt)
    if d:
        parts.append(f"dwt:{d}")
    t = _norm_type(vessel_type)
    if t:
        parts.append(f"type:{t}")
    it = _norm_type(imo_type)
    if it:
        parts.append(f"imotype:{it}")
    return "|".join(parts)


def match_key_from_particulars(particulars: dict[str, str]) -> str:
    return match_key(
        particulars.get("vessel_name") or "",
        particulars.get("imo_no") or "",
        year_built=particulars.get("year_built") or "",
        dwt=particulars.get("dwt") or "",
        vessel_type=particulars.get("vessel_type") or "",
        imo_type=particulars.get("imo_type") or "",
    )


def _identity_token(field: str, val: str) -> str:
    if field == "year_built":
        return _norm_year(val)
    if field == "dwt":
        return _norm_dwt(val)
    if field == "imo_no":
        imo = _clean(val)
        return imo if _IMO_RE.match(imo) else ""
    return _norm_type(val)


def _compatible(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """True when overlapping identity fields do not conflict."""
    for f in _IDENTITY_FIELDS:
        av = _identity_token(f, _clean(a.get(f)))
        bv = _identity_token(f, _clean(b.get(f)))
        if av and bv and av != bv:
            return False
    return True


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
    dwt_fmt, dwt_scaled, _had_k = _format_dwt_sdwt(dwt) if dwt else ("", False, False)
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
        "year_built": (_format_year_built(year)[0] if year else ""),
        "imo_type": imo_type,
        "dwt": dwt_fmt,
        "cbm": _format_rounded_figures(cbm) if cbm else "",
        "flag": _clean(dd.get("flag")),
        "sire_date": _clean(dd.get("sire_date")),
        "cdi_date": _clean(dd.get("cdi_date")),
        "tank_coating": _clean(dd.get("tank_coating")),
        "ai_normalized": ",".join(sorted(ai_flags)),
    }


def _merge_prefer_incoming(base: dict[str, str], extra: dict[str, str]) -> dict[str, str]:
    """Non-empty incoming values overwrite base (newer mail wins)."""
    out = dict(base)
    for f in LIBRARY_FIELDS:
        if f == "ai_normalized":
            flags = {p.strip() for p in _clean(out.get(f)).split(",") if p.strip()}
            flags |= {p.strip() for p in _clean(extra.get(f)).split(",") if p.strip()}
            out[f] = ",".join(sorted(flags))
            continue
        incoming = extra.get(f) or ""
        if incoming:
            out[f] = incoming
    return out


def _find_match(
    particulars: dict[str, str],
    by_key: dict[str, dict[str, Any]],
    by_name: dict[str, list[dict[str, Any]]],
) -> dict[str, Any] | None:
    key = match_key_from_particulars(particulars)
    if key and key in by_key:
        return by_key[key]
    imo = _clean(particulars.get("imo_no"))
    if _IMO_RE.match(imo):
        imo_key = f"imo:{imo}"
        if imo_key in by_key:
            return by_key[imo_key]
    name = _norm_name(particulars.get("vessel_name") or "")
    if not name:
        return None
    for row in by_name.get(name, []):
        if _compatible(row, particulars):
            return row
    return None


def _index_library_rows(rows: list[dict[str, Any]]) -> tuple[
    dict[str, dict[str, Any]],
    dict[str, list[dict[str, Any]]],
]:
    by_key: dict[str, dict[str, Any]] = {}
    by_name: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        key = row.get("match_key") or match_key_from_particulars(
            {f: _clean(row.get(f)) for f in LIBRARY_FIELDS}
        )
        if key:
            by_key[key] = row
        name = _norm_name(row.get("vessel_name") or "")
        if name:
            by_name.setdefault(name, []).append(row)
    return by_key, by_name


def _candidates_from_vessels(supabase) -> dict[str, dict[str, str]]:
    """One best-merged particulars dict per match key, from all extracted vessels."""
    rows = (
        supabase.table("vessels")
        .select("dynamic_data, created_at")
        .order("created_at")
        .execute()
    ).data or []
    # Build ordered list then soft-merge into buckets
    ordered: list[dict[str, str]] = []
    for row in rows:
        particulars = _particulars_from_dynamic(row.get("dynamic_data") or {})
        if not match_key_from_particulars(particulars) and not _norm_name(
            particulars.get("vessel_name") or ""
        ):
            continue
        ordered.append(particulars)

    buckets: list[dict[str, str]] = []
    for particulars in ordered:
        matched = None
        for bucket in buckets:
            key_a = match_key_from_particulars(bucket)
            key_b = match_key_from_particulars(particulars)
            if key_a and key_b and key_a == key_b:
                matched = bucket
                break
            imo_a = _clean(bucket.get("imo_no"))
            imo_b = _clean(particulars.get("imo_no"))
            if (
                _IMO_RE.match(imo_a)
                and _IMO_RE.match(imo_b)
                and imo_a == imo_b
            ):
                matched = bucket
                break
            if (
                _norm_name(bucket.get("vessel_name") or "")
                == _norm_name(particulars.get("vessel_name") or "")
                and _compatible(bucket, particulars)
            ):
                matched = bucket
                break
        if matched is None:
            buckets.append(dict(particulars))
        else:
            merged = _merge_prefer_incoming(matched, particulars)
            matched.clear()
            matched.update(merged)

    candidates: dict[str, dict[str, str]] = {}
    for bucket in buckets:
        key = match_key_from_particulars(bucket)
        if not key:
            continue
        candidates[key] = bucket
    return candidates


def _existing_keys(supabase) -> set[str]:
    rows = supabase.table("vessel_library").select("match_key").execute().data or []
    return {r.get("match_key") for r in rows if r.get("match_key")}


def rematch_library(supabase) -> dict[str, int]:
    """Recompute match_keys and merge soft-duplicate library rows."""
    rows = (
        supabase.table("vessel_library")
        .select("id, match_key, " + ", ".join(LIBRARY_FIELDS) + ", updated_at")
        .execute()
    ).data or []
    if not rows:
        return {"merged": 0, "updated": 0}

    # Sort so richer / newer rows tend to become the survivor
    def richness(r: dict) -> tuple:
        filled = sum(1 for f in LIBRARY_FIELDS if _clean(r.get(f)))
        return (filled, r.get("updated_at") or "")

    rows_sorted = sorted(rows, key=richness)
    survivors: list[dict[str, Any]] = []
    merged = 0
    updated = 0

    for row in rows_sorted:
        particulars = {f: _clean(row.get(f)) for f in LIBRARY_FIELDS}
        match = None
        for surviving in survivors:
            sp = {f: _clean(surviving.get(f)) for f in LIBRARY_FIELDS}
            key_a = match_key_from_particulars(sp)
            key_b = match_key_from_particulars(particulars)
            if key_a and key_b and key_a == key_b:
                match = surviving
                break
            imo_a = _clean(sp.get("imo_no"))
            imo_b = _clean(particulars.get("imo_no"))
            if _IMO_RE.match(imo_a) and _IMO_RE.match(imo_b) and imo_a == imo_b:
                match = surviving
                break
            if (
                _norm_name(sp.get("vessel_name") or "")
                == _norm_name(particulars.get("vessel_name") or "")
                and _compatible(sp, particulars)
            ):
                match = surviving
                break

        if match is None:
            new_key = match_key_from_particulars(particulars)
            if new_key and new_key != (row.get("match_key") or ""):
                supabase.table("vessel_library").update({
                    "match_key": new_key,
                    "updated_at": datetime.utcnow(),
                }).eq("id", row["id"]).execute()
                row["match_key"] = new_key
                updated += 1
            survivors.append(row)
            continue

        # Merge incoming into survivor, delete duplicate
        merged_fields = _merge_prefer_incoming(
            {f: _clean(match.get(f)) for f in LIBRARY_FIELDS},
            particulars,
        )
        new_key = match_key_from_particulars(merged_fields)
        patch = dict(merged_fields)
        patch["match_key"] = new_key
        patch["updated_at"] = datetime.utcnow()
        supabase.table("vessel_library").update(patch).eq("id", match["id"]).execute()
        for f, v in merged_fields.items():
            match[f] = v
        match["match_key"] = new_key
        supabase.table("vessel_library").delete().eq("id", row["id"]).execute()
        merged += 1

    if merged or updated:
        logger.info(
            "Vessel library rematch: merged=%d updated_keys=%d",
            merged,
            updated,
        )
    return {"merged": merged, "updated": updated}


# ── Public operations ────────────────────────────────────────────────────────

def autofill_library(supabase) -> dict[str, int]:
    """Sync vessel_library from extracted vessels.

    - Rematches / merges soft duplicates
    - Inserts vessels not yet in the library
    - Updates existing rows with non-empty incoming particulars

    Returns {"inserted": n, "updated": m, "merged": k}.
    """
    rematch_stats = rematch_library(supabase)
    candidates = _candidates_from_vessels(supabase)
    existing_rows = (
        supabase.table("vessel_library")
        .select("id, match_key, " + ", ".join(LIBRARY_FIELDS))
        .execute()
    ).data or []
    by_key, by_name = _index_library_rows(existing_rows)

    inserted = 0
    updated = 0
    for key, particulars in candidates.items():
        existing = _find_match(particulars, by_key, by_name)
        if existing:
            row = existing
            merged = _merge_prefer_incoming(
                {f: _clean(row.get(f)) for f in LIBRARY_FIELDS},
                particulars,
            )
            new_key = match_key_from_particulars(merged)
            patch: dict[str, Any] = {}
            for f in LIBRARY_FIELDS:
                if merged.get(f) != _clean(row.get(f)):
                    patch[f] = merged.get(f) or ""
            if new_key and new_key != (row.get("match_key") or ""):
                patch["match_key"] = new_key
            # Prefer formatted figures when only formatting differs
            for f in ("year_built", "dwt", "cbm"):
                current = _clean(row.get(f))
                preferred = merged.get(f) or ""
                if not preferred and current:
                    preferred = (
                        _format_year_built(current)[0] if f == "year_built"
                        else (
                            _format_dwt_sdwt(current)[0]
                            if f == "dwt"
                            else _format_rounded_figures(current)
                        )
                    )
                if preferred and preferred != current:
                    patch[f] = preferred
            if patch:
                patch["updated_at"] = datetime.utcnow()
                supabase.table("vessel_library").update(patch).eq("id", row["id"]).execute()
                old_key = row.get("match_key") or ""
                for f, v in patch.items():
                    if f != "updated_at":
                        row[f] = v
                row_key = row.get("match_key") or new_key
                if old_key and old_key in by_key and by_key[old_key].get("id") == row["id"]:
                    del by_key[old_key]
                if row_key:
                    by_key[row_key] = row
                name = _norm_name(row.get("vessel_name") or "")
                if name:
                    by_name.setdefault(name, [])
                    if not any(r.get("id") == row["id"] for r in by_name[name]):
                        by_name[name].append(row)
                updated += 1
            continue

        payload = dict(particulars)
        payload["match_key"] = key
        # Carry API enrichment (yellow-cell fields) when promoting via Review all.
        try:
            from vessel_enrichment import _cache_load_all, ENRICH_FIELDS, _clean as _eclean

            hit = (_cache_load_all(supabase) or {}).get(key)
            if hit:
                sourced = []
                for f in ENRICH_FIELDS:
                    val = _eclean((hit.get("payload") or {}).get(f))
                    if val and not _clean(payload.get(f)):
                        payload[f] = val
                        sourced.append(f)
                for f in hit.get("api_sourced") or []:
                    if f in ENRICH_FIELDS and _clean(payload.get(f)) and f not in sourced:
                        sourced.append(f)
                if sourced:
                    payload["api_sourced"] = sourced
        except Exception:  # noqa: BLE001
            pass
        result = supabase.table("vessel_library").insert(payload).execute()
        inserted += 1
        if result.data:
            row = result.data[0]
            existing_rows.append(row)
            by_key[key] = row
            name = _norm_name(row.get("vessel_name") or "")
            if name:
                by_name.setdefault(name, []).append(row)

    # Reformat any remaining library rows (including library-only entries).
    updated += normalize_library_formats(supabase)

    if inserted or updated or rematch_stats.get("merged"):
        logger.info(
            "Vessel library sync: inserted=%d updated=%d merged=%d",
            inserted,
            updated,
            rematch_stats.get("merged", 0),
        )
    return {
        "inserted": inserted,
        "updated": updated,
        "merged": rematch_stats.get("merged", 0),
    }


def normalize_library_formats(supabase) -> int:
    """Re-format year_built / dwt / cbm / text casing on all vessel_library rows (idempotent)."""
    rows = (
        supabase.table("vessel_library")
        .select(
            "id, vessel_name, vessel_type, flag, year_built, dwt, cbm, ai_normalized"
        )
        .execute()
    ).data or []
    updated = 0
    for row in rows:
        patch: dict[str, Any] = {}
        flags = {p.strip() for p in _clean(row.get("ai_normalized")).split(",") if p.strip()}

        name = _clean(row.get("vessel_name"))
        if name:
            fmt = _normalize_vessel_name_case(name)
            if fmt and fmt != name:
                patch["vessel_name"] = fmt
        vtype = _clean(row.get("vessel_type"))
        if vtype:
            fmt = _normalize_vessel_type_case(vtype)
            if fmt and fmt != vtype:
                patch["vessel_type"] = fmt
        flag = _clean(row.get("flag"))
        if flag:
            fmt = title_case_text(flag)
            if fmt and fmt != flag:
                patch["flag"] = fmt

        year = _clean(row.get("year_built"))
        if year:
            fmt, expanded = _format_year_built(year)
            if fmt and fmt != year:
                patch["year_built"] = fmt
            if expanded:
                flags.add("year_built")
        dwt = _clean(row.get("dwt"))
        if dwt:
            fmt, scaled, had_k = _format_dwt_sdwt(dwt)
            if fmt and fmt != dwt:
                patch["dwt"] = fmt
            if scaled:
                flags.add("dwt")
            elif had_k:
                flags.discard("dwt")
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
        cbm = _clean(row.get("cbm"))
        if cbm:
            fmt = _format_rounded_figures(cbm)
            if fmt and fmt != cbm:
                patch["cbm"] = fmt
        new_flags = ",".join(sorted(flags))
        if new_flags != _clean(row.get("ai_normalized")):
            patch["ai_normalized"] = new_flags
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
        .select("id, " + ", ".join(LIBRARY_FIELDS) + ", match_key, api_sourced, created_at, updated_at")
        .execute()
    ).data or []
    rows.sort(key=lambda r: (r.get("vessel_name") or "").upper())
    return rows


def detect_new_vessels(supabase) -> list[dict[str, Any]]:
    """Vessels present in position data but not yet in the library."""
    candidates = _candidates_from_vessels(supabase)
    existing_rows = (
        supabase.table("vessel_library")
        .select("id, match_key, " + ", ".join(LIBRARY_FIELDS))
        .execute()
    ).data or []
    by_key, by_name = _index_library_rows(existing_rows)
    new_rows: list[dict[str, Any]] = []
    for key, particulars in candidates.items():
        if _find_match(particulars, by_key, by_name):
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

    If a matching row already exists, particulars are upserted and returned.
    """
    payload = _payload_from_fields(fields)
    key = match_key_from_particulars(payload)
    payload["match_key"] = key
    sourced = fields.get("api_sourced")
    if isinstance(sourced, list):
        payload["api_sourced"] = [str(x) for x in sourced if str(x)]

    existing_rows = (
        supabase.table("vessel_library")
        .select("id, match_key, api_sourced, " + ", ".join(LIBRARY_FIELDS))
        .execute()
    ).data or []
    by_key, by_name = _index_library_rows(existing_rows)
    existing = _find_match(payload, by_key, by_name) if key or _norm_name(
        payload.get("vessel_name") or ""
    ) else None
    if existing:
        merged = _merge_prefer_incoming(
            {f: _clean(existing.get(f)) for f in LIBRARY_FIELDS},
            payload,
        )
        merged["match_key"] = match_key_from_particulars(merged)
        # Keep union of API-sourced markers for fields still filled from API values.
        prev_src = existing.get("api_sourced") if isinstance(existing.get("api_sourced"), list) else []
        new_src = payload.get("api_sourced") if isinstance(payload.get("api_sourced"), list) else []
        merged["api_sourced"] = sorted({*map(str, prev_src), *map(str, new_src)})
        merged["updated_at"] = datetime.utcnow()
        result = (
            supabase.table("vessel_library")
            .update(merged)
            .eq("id", existing["id"])
            .execute()
        )
        return result.data[0] if result.data else existing

    result = supabase.table("vessel_library").insert(payload).execute()
    return result.data[0]


def update_library_vessel(supabase, vessel_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    # Only overwrite fields present in the request so omitted legacy columns are kept.
    present = {f: _clean(fields.get(f)) for f in LIBRARY_FIELDS if f in fields}
    existing = (
        supabase.table("vessel_library")
        .select("id, match_key, " + ", ".join(LIBRARY_FIELDS))
        .eq("id", vessel_id)
        .limit(1)
        .execute()
    ).data or []
    if not existing:
        raise ValueError("Vessel not found.")
    row = existing[0]
    merged = {f: _clean(row.get(f)) for f in LIBRARY_FIELDS}
    merged.update(present)
    payload = dict(present)
    payload["match_key"] = match_key_from_particulars(merged)
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
