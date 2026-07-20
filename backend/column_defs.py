"""
Column definitions (PostgreSQL source of truth) and legacy → standard field mapping.
"""
from __future__ import annotations

import logging
import re
import json
from typing import Any

logger = logging.getLogger(__name__)

EMPTY_VALUES = frozenset({
    "", "-", "—", "–", ".", "..", "n/a", "na", "none", "null", "unknown", "tba", "tbc", "tbd",
})

# Keys stored in vessels.dynamic_data (region is vessels.region column).
STANDARD_DYNAMIC_KEYS: list[str] = [
    "company",
    "imo",
    "vessel_name",
    "call_sign",
    "year_built",
    "vessel_type",
    "cargo_type",
    "direction",
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
    {"id": "company", "header": "COMPANY", "display_order": 2, "read_only": False, "storage": "dynamic_data"},
    {"id": "vessel_name", "header": "VESSEL NAME", "display_order": 3, "read_only": False, "storage": "dynamic_data"},
    {"id": "call_sign", "header": "CALL SIGN", "display_order": 4, "read_only": False, "storage": "dynamic_data"},
    {"id": "year_built", "header": "YEAR BUILT", "display_order": 5, "read_only": False, "storage": "dynamic_data"},
    {"id": "vessel_type", "header": "VESSEL TYPE", "display_order": 6, "read_only": False, "storage": "dynamic_data"},
    {"id": "cargo_type", "header": "CARGO TYPE", "display_order": 7, "read_only": False, "storage": "dynamic_data"},
    {"id": "direction", "header": "DIRECTION", "display_order": 8, "read_only": False, "storage": "dynamic_data"},
    {"id": "dwt_sdwt", "header": "DWT/SDWT", "display_order": 9, "read_only": False, "storage": "dynamic_data"},
    {"id": "cbm", "header": "CBM/CUBIC METER", "display_order": 10, "read_only": False, "storage": "dynamic_data"},
    {"id": "draft", "header": "DRAFT", "display_order": 11, "read_only": False, "storage": "dynamic_data"},
    {"id": "flag", "header": "FLAG", "display_order": 12, "read_only": False, "storage": "dynamic_data"},
    {"id": "eta_foc", "header": "ETA FOC", "display_order": 13, "read_only": False, "storage": "dynamic_data"},
    {"id": "region", "header": "REGION", "display_order": 14, "read_only": False, "storage": "region"},
    {"id": "open_location", "header": "OPEN LOCATION", "display_order": 15, "read_only": False, "storage": "dynamic_data"},
    {"id": "opening_date", "header": "OPENING DATE", "display_order": 16, "read_only": False, "storage": "dynamic_data"},
    {"id": "cargo_history_combo", "header": "CARGO HISTORY/L3C/LAST 3 CARGOES", "display_order": 17, "read_only": False, "storage": "dynamic_data"},
    {"id": "tank_coating", "header": "TANK COATING", "display_order": 18, "read_only": False, "storage": "dynamic_data"},
    {"id": "sire_date", "header": "SIRE DATE", "display_order": 19, "read_only": False, "storage": "dynamic_data"},
    {"id": "sire_location", "header": "SIRE LOCATION", "display_order": 20, "read_only": False, "storage": "dynamic_data"},
    {"id": "cdi_date", "header": "CDI DATE", "display_order": 21, "read_only": False, "storage": "dynamic_data"},
    {"id": "cdi_location", "header": "CDI LOCATION", "display_order": 22, "read_only": False, "storage": "dynamic_data"},
    {"id": "remarks", "header": "REMARKS", "display_order": 23, "read_only": False, "storage": "dynamic_data"},
    {"id": "other_info", "header": "OTHER INFO", "display_order": 24, "read_only": True, "storage": "dynamic_data"},
    {"id": "q88", "header": "Q88 AVAILABLE", "display_order": 25, "read_only": False, "storage": "dynamic_data"},
    {"id": "attachments", "header": "ATTACHMENTS", "display_order": 26, "read_only": True, "storage": "derived"},
    {"id": "status", "header": "STATUS", "display_order": 27, "read_only": False, "storage": "dynamic_data"},
]

# Default visible columns used for attachment confidence (matches POSITION_LIST_SUMMARY
# in frontend minus SR. NO). Score ≈ % of applicable columns filled per vessel.
CONFIDENCE_DEFAULT_COLUMNS: tuple[str, ...] = (
    "imo",
    "company",
    "vessel_name",
    "region",
    "dwt_sdwt",
    "year_built",
    "tank_coating",
    "open_location",
    "opening_date",
    "direction",
    "cargo_history_combo",
)

# Max applicable columns unfilled before forcing Need to Review.
CONFIDENCE_MAX_UNFILLED = 5


def normalize_columns_in_email(raw: list | None) -> list[str]:
    """Filter/normalize LLM columns_in_email; fall back to all defaults when absent."""
    allowed = set(CONFIDENCE_DEFAULT_COLUMNS)
    if not raw:
        return list(CONFIDENCE_DEFAULT_COLUMNS)
    out: list[str] = []
    for item in raw:
        key = str(item or "").strip().lower().replace(" ", "_")
        if key in allowed and key not in out:
            out.append(key)
    return out if out else list(CONFIDENCE_DEFAULT_COLUMNS)

IMO_NUMBER_RE = re.compile(r"^\d{7}$")
IMO_EMBEDDED_RE = re.compile(r"\b(\d{7})\b")


def company_name_from_filename(filename: str) -> str:
    """Broker / list label from the source .eml attachment filename."""
    return re.sub(r"\.eml$", "", (filename or "").strip(), flags=re.I)


_GENERIC_COMPANY_RE = re.compile(
    r"^(?:attachment_\d{3}|vessel\s+open\s+position(?:_\d+)?)$",
    re.I,
)
_COMPANY_LINE_RE = re.compile(
    r"\b(?:ltd\.?|limited|pte\.?\s*ltd|inc\.?|corp\.?|gmbh|s\.?a\.?|b\.?v\.?)\b",
    re.I,
)
_COMPANY_HINT_RE = re.compile(
    r"\b(?:shipping|tankers|maritime|logistics|chartering|brokers?|energy|petroleum|chem(?:ical)?)\b",
    re.I,
)


def is_generic_company_name(name: str) -> bool:
    s = (name or "").strip()
    if not s or len(s) < 3:
        return True
    return bool(_GENERIC_COMPANY_RE.match(s))


def _parse_mail_display_name(header: str) -> str:
    header = (header or "").strip()
    if not header:
        return ""
    m = re.match(r'^"([^"]+)"\s*<', header)
    if m:
        name = m.group(1).strip()
        if "@" not in name:
            return name
    m = re.match(r"^([^<]+)<", header)
    if m:
        name = m.group(1).strip().strip('"')
        if name and "@" not in name and not is_generic_company_name(name):
            return name
    return ""


def _company_from_raw_signature(raw_text: str) -> str:
    """Last company-like line in the email tail (signature block)."""
    lines = [ln.strip() for ln in (raw_text or "").splitlines() if ln.strip()]
    if not lines:
        return ""
    tail = lines[-25:]
    candidates: list[str] = []
    for ln in tail:
        if len(ln) < 4 or len(ln) > 140:
            continue
        if "@" in ln or "http" in ln.lower() or "www." in ln.lower():
            continue
        if re.match(r"^[_\-=•·]+$", ln):
            continue
        if _COMPANY_LINE_RE.search(ln) or _COMPANY_HINT_RE.search(ln):
            candidates.append(ln)
    if candidates:
        return candidates[0]
    return ""


def _match_company_from_vessel_name(vessel_name: str, companies: list[str]) -> str:
    clean = re.sub(r"^(?:mt|m/t|mv|m\.v\.)\s+", "", (vessel_name or "").strip(), flags=re.I)
    clean_upper = clean.upper()
    for company in companies:
        token = (company or "").split()[0].upper()
        if len(token) >= 4 and token in clean_upper:
            return company.strip()
    return ""


def resolve_vessel_company(
    filename: str,
    *,
    mail_from: str = "",
    parent_sender: str = "",
    raw_text: str = "",
    vessel_name: str = "",
    llm_company: str = "",
    broker_companies: list[str] | None = None,
) -> str:
    """Best-effort owner/operator company label for one vessel row.

    NOTE: in the direct-mail (production) pipeline `filename` is the email
    SUBJECT line — which is NOT the company — so it is only used as an absolute
    last resort and only if it actually looks like a company name.
    """
    if _has_value(llm_company) and not is_generic_company_name(llm_company):
        return str(llm_company).strip()

    if vessel_name and broker_companies:
        matched = _match_company_from_vessel_name(vessel_name, broker_companies)
        if matched:
            return matched

    signature = _company_from_raw_signature(raw_text)
    if signature:
        return signature

    for hdr in (mail_from, parent_sender):
        display = _parse_mail_display_name(hdr)
        if display and not is_generic_company_name(display):
            return display

    # Last resort: only if the source label reads like a real company, never a
    # position-list subject line ("... Position List", "Open Position", etc.).
    from_file = company_name_from_filename(filename)
    if (
        from_file
        and not is_generic_company_name(from_file)
        and (_COMPANY_LINE_RE.search(from_file) or _COMPANY_HINT_RE.search(from_file))
        and not re.search(r"\b(position|positions|open|list|tonnage)\b", from_file, re.I)
    ):
        return from_file

    return ""


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
    if re.match(r"^\d+(/\d+)?$", norm):
        return True
    if re.match(r"^(i{1,3}|ii|iii|iv)(/(i{1,3}|ii|iii|iv))?$", norm):
        return True
    return False


def _resolve_imo_for_grid(dd: dict) -> str:
    """IMO column: 7-digit number, or IMO type (2, 2/3, IMO II) when no number."""
    num = _extract_imo_number(dd)
    if num:
        return num
    for k in ("imo", "imo_type", "vessel_type"):
        v = dd.get(k)
        if _looks_like_imo_type(v):
            return str(v).strip()
    return ""


def _resolve_vessel_type(dd: dict) -> str:
    if _has_value(dd.get("vessel_type")):
        vt = str(dd["vessel_type"]).strip()
        if _looks_like_imo_type(vt):
            return ""
        return vt
    primary = _first_hit(dd, ["vessel_type", "type", "tank_type"])
    if primary and not _looks_like_imo_type(primary):
        return primary
    return ""


def _normalize_imo_and_vessel_type(out: dict[str, str]) -> None:
    """Keep IMO type codes out of vessel_type (common LLM / legacy mis-map)."""
    imo = (out.get("imo") or "").strip()
    vt = (out.get("vessel_type") or "").strip()
    if _looks_like_imo_type(vt) and not _has_value(imo):
        out["imo"] = vt
        out["vessel_type"] = ""
    elif _looks_like_imo_type(vt) or (vt and imo and vt.lower() == imo.lower()):
        out["vessel_type"] = ""


def _resolve_open_fields(dd: dict) -> tuple[str, str]:
    if _has_value(dd.get("open_location")):
        loc = str(dd["open_location"]).strip()
    else:
        open_used = None
        loc = ""
        for k in ("port_name", "port", "position", "area", "open"):
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


# ── Trading direction ────────────────────────────────────────────────────────
_DIRECTION_CANON = {
    "ANY", "NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND",
    "WCI", "AG", "WCI/AG", "FAR EAST", "SEA", "WORLDWIDE", "WEST INDIA",
}

# Full normaliser for an explicit direction phrase (short, dedicated field).
_DIRECTION_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"wci\s*[/&]\s*ag|ag\s*[/&]\s*wci", re.I), "WCI/AG"),
    (re.compile(r"north\s*bound|northbound|\bn\.?b\.?\b", re.I), "NORTHBOUND"),
    (re.compile(r"south\s*bound|southbound|\bs\.?b\.?\b", re.I), "SOUTHBOUND"),
    (re.compile(r"east\s*bound|eastbound|\be\.?b\.?\b", re.I), "EASTBOUND"),
    (re.compile(r"west\s*bound|westbound|\bw\.?b\.?\b", re.I), "WESTBOUND"),
    (re.compile(r"far\s*east|f\.?\s*east|feast", re.I), "FAR EAST"),
    (re.compile(r"world\s*wide|worldwide|\bw\.?w\.?\b|trading\s+worldwide", re.I), "WORLDWIDE"),
    (re.compile(r"west\s+india", re.I), "WEST INDIA"),
    (re.compile(r"wci|west\s+coast\s+india", re.I), "WCI"),
    (re.compile(r"\bag\b|arabian\s+gulf", re.I), "AG"),
    (re.compile(r"south\s*east\s*asia|\bsea\b", re.I), "SEA"),
    (re.compile(r"any\s*dir\w*|any\s+direction|\bany\b", re.I), "ANY"),
]

# Stricter patterns for scanning INSIDE larger free-text fields (avoid bare
# words like "any"/"ag"/"sea" that appear in unrelated prose).
_DIRECTION_TEXT_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"wci\s*[/&]\s*ag|ag\s*[/&]\s*wci", re.I), "WCI/AG"),
    (re.compile(r"north\s*bound|northbound", re.I), "NORTHBOUND"),
    (re.compile(r"south\s*bound|southbound", re.I), "SOUTHBOUND"),
    (re.compile(r"east\s*bound|eastbound", re.I), "EASTBOUND"),
    (re.compile(r"west\s*bound|westbound", re.I), "WESTBOUND"),
    (re.compile(r"any\s*dir\w*|any\s+direction", re.I), "ANY"),
    (re.compile(r"far\s*east|feast", re.I), "FAR EAST"),
    (re.compile(r"world\s*wide|worldwide|trading\s+worldwide", re.I), "WORLDWIDE"),
    (re.compile(r"\bwci\b|west\s+coast\s+india", re.I), "WCI"),
]


def _normalize_direction(text: str) -> str:
    """Map a short direction phrase to a canonical token; '' if unrecognized."""
    if not text:
        return ""
    up = re.sub(r"\s+", " ", str(text).strip().upper())
    if up in _DIRECTION_CANON:
        return up
    for pat, canon in _DIRECTION_PATTERNS:
        if pat.search(str(text)):
            return canon
    return ""


def _derive_direction_from_text(text: str) -> str:
    for pat, canon in _DIRECTION_TEXT_PATTERNS:
        if pat.search(text):
            return canon
    return ""


def _resolve_direction(dd: dict) -> str:
    """Direction from an explicit key, else derived from free-text fields."""
    explicit = _first_hit(dd, ["direction", "dir"])
    if explicit:
        return _normalize_direction(explicit) or explicit.strip().upper()
    for k in ("cargo_type", "remarks", "other_info", "cargo_history_combo", "status"):
        v = dd.get(k)
        if _has_value(v):
            derived = _derive_direction_from_text(str(v))
            if derived:
                return derived
    return ""


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
        _normalize_imo_and_vessel_type(out)
        reg = (region or _first_hit(src, ["region"]) or "").strip()
        return out, reg

    loc, date = _resolve_open_fields(src)
    out: dict[str, str] = {
        "company": _first_hit(src, ["company"]),
        "imo": _resolve_imo_for_grid(src),
        "vessel_name": _first_hit(src, ["vessel_name", "name"]),
        "call_sign": _first_hit(src, ["call_sign"]),
        "year_built": _first_hit(src, ["year_built", "built", "yard_built", "year", "when"]),
        "vessel_type": _resolve_vessel_type(src),
        "cargo_type": _first_hit(src, ["cargo_type", "grade", "last_cargo", "cargo_preference"]),
        "direction": _resolve_direction(src),
        "dwt_sdwt": _resolve_dwt_sdwt(src),
        "cbm": _first_hit(src, ["cbm", "cubic", "cub", "cargo_tank_capacity", "m3", "capacity"]),
        "draft": _first_hit(src, ["draft", "sdraft", "sdwt_draft"]),
        "flag": _first_hit(src, ["flag"]),
        "eta_foc": _first_hit(src, ["eta_foc", "eta foc"]),
        "open_location": loc,
        "opening_date": date,
        "cargo_history_combo": _resolve_cargo_history(src),
        "tank_coating": _first_hit(src, ["tank_coating", "coating", "coat", "tanks", "tank_type"]),
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
    _normalize_imo_and_vessel_type(out)
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


def fix_imo_vessel_type_misplacement(supabase) -> int:
    """Re-map rows where IMO type was stored in vessel_type (safe to run every startup)."""
    rows = supabase.table("vessels").select("id, dynamic_data, region").execute()
    updated = 0
    for vessel in rows.data or []:
        dd = vessel.get("dynamic_data") or {}
        standardized, reg = map_raw_to_standard(dd, vessel.get("region"))
        old_vt = str(dd.get("vessel_type") or "").strip()
        new_vt = str(standardized.get("vessel_type") or "").strip()
        old_imo = str(dd.get("imo") or "").strip()
        new_imo = str(standardized.get("imo") or "").strip()
        if old_vt == new_vt and old_imo == new_imo and standardized == dd:
            continue
        supabase.table("vessels").update({
            "dynamic_data": standardized,
            "region": reg,
        }).eq("id", vessel["id"]).execute()
        updated += 1
    if updated:
        logger.info("Fixed IMO/vessel_type placement on %d vessel rows", updated)
    return updated


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


def backfill_vessel_company_names(supabase) -> int:
    """Set dynamic_data.company using filename, signature, contacts, and vessel-name hints."""
    vessels = supabase.table("vessels").select("id, attachment_id, dynamic_data").execute()
    vessel_rows = vessels.data or []
    if not vessel_rows:
        return 0

    att_ids = list({v["attachment_id"] for v in vessel_rows if v.get("attachment_id")})
    if not att_ids:
        return 0

    att_rows = (
        supabase.table("attachments")
        .select("id, filename, mail_from, mail_subject, raw_text, parent_email_id")
        .in_("id", att_ids)
        .execute()
    ).data or []
    att_by_id = {a["id"]: a for a in att_rows}

    parent_ids = list({a.get("parent_email_id") for a in att_rows if a.get("parent_email_id")})
    parent_sender: dict[str, str] = {}
    if parent_ids:
        parents = (
            supabase.table("parent_emails")
            .select("id, sender")
            .in_("id", parent_ids)
            .execute()
        ).data or []
        parent_sender = {p["id"]: p.get("sender") or "" for p in parents}

    contacts_by_att: dict[str, list[str]] = {aid: [] for aid in att_ids}
    contact_rows = (
        supabase.table("broker_contacts")
        .select("attachment_id, company")
        .in_("attachment_id", att_ids)
        .execute()
    ).data or []
    for row in contact_rows:
        aid = row.get("attachment_id")
        company = (row.get("company") or "").strip()
        if aid and company and company not in contacts_by_att.get(aid, []):
            contacts_by_att.setdefault(aid, []).append(company)

    updated = 0
    for vessel in vessel_rows:
        att_id = vessel.get("attachment_id")
        att = att_by_id.get(att_id, {})
        dd = dict(vessel.get("dynamic_data") or {})
        vessel_name = dd.get("vessel_name") or ""
        company = resolve_vessel_company(
            att.get("filename") or "",
            mail_from=att.get("mail_from") or "",
            parent_sender=parent_sender.get(att.get("parent_email_id") or "", ""),
            raw_text=att.get("raw_text") or "",
            vessel_name=vessel_name,
            broker_companies=contacts_by_att.get(att_id, []),
        )
        if not company:
            continue
        if (dd.get("company") or "").strip() == company:
            continue
        dd["company"] = company
        supabase.table("vessels").update({"dynamic_data": dd}).eq("id", vessel["id"]).execute()
        updated += 1

    if updated:
        logger.info("Backfilled company on %d vessel rows", updated)
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


def format_attachment_files(files: Any) -> str:
    """Comma-separated names of real file attachments (PDF/image/xlsx…) on the email."""
    if not files:
        return ""
    if isinstance(files, str):
        try:
            files = json.loads(files)
        except json.JSONDecodeError:
            return ""
    if not isinstance(files, list):
        return ""
    names: list[str] = []
    for entry in files:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if name:
            names.append(name)
    return ", ".join(names)


def resolve_cell_value(vessel: dict, column_id: str, row_num: int = 1) -> str:
    if column_id == "_num":
        return str(row_num)
    if column_id == "region":
        return str(vessel.get("region") or "").strip()
    if column_id == "attachments":
        return format_attachment_files(vessel.get("attachment_files"))
    if column_id == "vessel_type":
        dd = vessel.get("dynamic_data") or {}
        vt = str(dd.get("vessel_type") or "").strip()
        imo = str(dd.get("imo") or "").strip()
        if _looks_like_imo_type(vt) or (vt and imo and vt.lower() == imo.lower()):
            return ""
        return vt
    if column_id == "imo":
        dd = vessel.get("dynamic_data") or {}
        imo = str(dd.get("imo") or "").strip()
        if imo:
            return imo
        vt = dd.get("vessel_type")
        if _looks_like_imo_type(vt):
            return str(vt).strip()
        return ""
    dd = vessel.get("dynamic_data") or {}
    return str(dd.get(column_id) or "").strip()


def header_for_column(column_id: str, columns: list[dict] | None = None) -> str:
    cols = columns or DEFAULT_COLUMN_DEFINITIONS
    for c in cols:
        if c["id"] == column_id:
            return c["header"]
    return column_id.replace("_", " ").upper()
