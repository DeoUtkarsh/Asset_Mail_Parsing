"""
Standard trade regions derived from open_location (not broker email region text).

Source of truth (PostgreSQL):
  - trade_regions           region code → display name + zone
  - trade_ports             port / country → region code
  - open_location_aliases   broker slang → region code

Rules (code — not in DB):
  1. Alias match first
  2. Exact / contained port name match
  3. SEA vs STRAITS: Spore/Straits-style opens → STRAITS; else SEA when both fit
  4. Compound opens (A / B): map tokens; prefer first decisive area-code token;
     if conflicting regions with no clear primary → UNSPECIFIED
  5. Blank open_location → UNSPECIFIED (do not invent from broker region)
"""
from __future__ import annotations

import logging
import re
from functools import lru_cache

logger = logging.getLogger(__name__)

UNSPECIFIED = "UNSPECIFIED"

# Matching heuristics only — reference data lives in DB.
_STRAITS_HINTS = (
    "spore", "straits", "singapore strait", "singapore straits",
    "malacca", "jurong", "batam", "karimun", "opl", "anchorage",
)


def _norm(text: str) -> str:
    s = str(text or "").lower().replace("’", "'").replace("`", "'")
    s = s.replace("-", " ").replace("_", " ")
    s = re.sub(r"[^\w\s/]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def clear_region_map_cache() -> None:
    _load_map.cache_clear()


@lru_cache(maxsize=1)
def _load_map() -> dict:
    """Load region/port/alias indexes from PostgreSQL."""
    try:
        from database import supabase
    except Exception as exc:
        logger.warning("region_map: cannot import database (%s)", exc)
        return {
            "region_codes": {},
            "region_zones": {},
            "aliases": {},
            "port_index": {},
        }

    region_rows = supabase.table("trade_regions").select("code, name, zone").execute().data or []
    port_rows = supabase.table("trade_ports").select("port_name, region_code").execute().data or []
    alias_rows = (
        supabase.table("open_location_aliases").select("alias, region_code").execute().data or []
    )

    region_codes: dict[str, str] = {}
    region_zones: dict[str, str] = {}
    for row in region_rows:
        code = str(row.get("code") or "").strip()
        if not code:
            continue
        region_codes[code] = str(row.get("name") or code).strip() or code
        region_zones[code] = str(row.get("zone") or "").strip()

    aliases: dict[str, str] = {}
    for row in alias_rows:
        alias = _norm(row.get("alias") or "")
        code = str(row.get("region_code") or "").strip()
        if alias and code:
            aliases[alias] = code

    port_index: dict[str, set[str]] = {}
    for row in port_rows:
        code = str(row.get("region_code") or "").strip()
        port = _norm(row.get("port_name") or "")
        if not code or not port:
            continue
        port_index.setdefault(port, set()).add(code)
        base = re.sub(r"\([^)]*\)", "", port).strip()
        if base and base != port:
            port_index.setdefault(base, set()).add(code)

    for code in region_codes:
        port_index.setdefault(_norm(code), set()).add(code)
        for part in re.split(r"[/\s]+", code):
            p = _norm(part)
            if len(p) >= 2:
                port_index.setdefault(p, set()).add(code)

    if not region_codes:
        logger.warning("trade_regions is empty — run ensure_trade_geo_seeded on startup")

    return {
        "region_codes": region_codes,
        "region_zones": region_zones,
        "aliases": aliases,
        "port_index": port_index,
    }


def is_standard_region(value: str | None) -> bool:
    if not value:
        return False
    t = str(value).strip()
    if t.upper() == UNSPECIFIED:
        return True
    return region_label_to_code(t) is not None


def region_code_to_name(code: str | None) -> str:
    """Display name for a region code (from trade_regions.name).

    Parenthetical notes in seed names are stripped for vessel storage/UI
    (e.g. 'Continent (ARA range)' → 'Continent').
    """
    c = str(code or "").strip()
    if not c or c.upper() == UNSPECIFIED:
        return UNSPECIFIED
    names: dict[str, str] = _load_map().get("region_codes") or {}
    raw_name = ""
    if c in names:
        raw_name = names[c]
    else:
        for k, name in names.items():
            if _norm(k) == _norm(c):
                raw_name = name
                break
    if not raw_name:
        raw_name = c
    cleaned = _strip_parenthetical_extras(raw_name)
    return cleaned or raw_name or UNSPECIFIED


def region_label_to_code(label: str | None) -> str | None:
    """Accept a region code or display name → canonical region code."""
    t = str(label or "").strip()
    if not t:
        return None
    if t.upper() == UNSPECIFIED:
        return UNSPECIFIED
    codes: dict[str, str] = _load_map().get("region_codes") or {}
    if t in codes:
        return t
    for k in codes:
        if _norm(k) == _norm(t):
            return k
    for k, name in codes.items():
        if name == t or _norm(name) == _norm(t):
            return k
    return None


def _alias_lookup(token: str) -> str | None:
    aliases: dict[str, str] = _load_map().get("aliases") or {}
    key = _norm(token)
    if not key:
        return None
    if key in aliases:
        return aliases[key]
    compact = key.replace(" ", "")
    for a, code in aliases.items():
        if a.replace(" ", "") == compact:
            return code
    return None


def _port_hits(token: str) -> set[str]:
    index: dict[str, set[str]] = _load_map().get("port_index") or {}
    key = _norm(token)
    if not key:
        return set()
    hits: set[str] = set()
    if key in index:
        hits |= set(index[key])
    if len(key) >= 4:
        for port, codes in index.items():
            if len(port) < 4:
                continue
            if key == port or key in port or port in key:
                hits |= set(codes)
    return hits


def _prefer_straits(open_text: str, codes: set[str]) -> set[str]:
    """When a port sits in both SEA and STRAITS: Straits-style → STRAITS, else SEA."""
    if "STRAITS" in codes and "SEA" in codes:
        low = _norm(open_text)
        if (
            any(h in low for h in _STRAITS_HINTS)
            or low in {"singapore", "spore"}
            or "singapore" in low
        ):
            return {"STRAITS"}
        return {"SEA"}
    return codes


def _split_compound(open_location: str) -> list[str]:
    raw = str(open_location or "").strip()
    if not raw:
        return []
    parts = re.split(r"\s*/\s*|\s*,\s*|\s+-\s+", raw)
    out = [p.strip() for p in parts if p and p.strip()]
    return out or [raw]


def _resolve_token(token: str) -> set[str]:
    alias = _alias_lookup(token)
    if alias:
        return {alias}
    return _port_hits(token)


def resolve_region_from_open_location(open_location: str | None) -> str:
    """Return a standard Region Code, or UNSPECIFIED."""
    text = str(open_location or "").strip()
    if not text:
        return UNSPECIFIED

    whole_alias = _alias_lookup(text)
    if whole_alias and "/" not in text and " - " not in text:
        return whole_alias

    tokens = _split_compound(text)
    token_results: list[tuple[str, set[str]]] = []
    for tok in tokens:
        hits = _prefer_straits(tok, _resolve_token(tok))
        token_results.append((tok, hits))

    full_hits = _prefer_straits(text, _resolve_token(text))
    if full_hits and len(full_hits) == 1:
        return next(iter(full_hits))

    decisive: list[str] = []
    for tok, hits in token_results:
        if len(hits) == 1:
            decisive.append(next(iter(hits)))
        elif hits:
            pref = _prefer_straits(tok, hits)
            if len(pref) == 1:
                decisive.append(next(iter(pref)))

    if not decisive and full_hits:
        pref = _prefer_straits(text, full_hits)
        if len(pref) == 1:
            return next(iter(pref))
        return UNSPECIFIED

    if not decisive:
        return UNSPECIFIED

    unique = list(dict.fromkeys(decisive))
    if len(unique) == 1:
        return unique[0]

    if "INDIA / WCI" in unique and "AG / PG" in unique:
        low = _norm(text)
        if "wci" in low or "west india" in low or "west coast" in low:
            return "INDIA / WCI"
        return "AG / PG"

    first_tok = tokens[0] if tokens else text
    first_alias = _alias_lookup(first_tok)
    if first_alias:
        return first_alias
    return UNSPECIFIED


def _strip_parenthetical_extras(text: str | None) -> str:
    s = str(text or "").strip()
    if not s:
        return ""
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"\s*\([^)]*\)", "", s).strip()
        s = re.sub(r"\s*\[[^\]]*\]", "", s).strip()
    return re.sub(r"\s{2,}", " ", s).strip()


def derive_vessel_region(
    open_location: str | None,
    broker_region: str | None = None,
) -> tuple[str, str]:
    """Return (display_region_name, region_raw).

    Prefer open_location → DB/alias map. If that yields UNSPECIFIED, fall back to
    region phrases from the mail (broker_region / AREA text), then UNSPECIFIED.
    Bracketed notes are stripped from both open location and broker region text.
    """
    loc = _strip_parenthetical_extras(open_location)
    raw_full = str(broker_region or "").strip()
    raw = _strip_parenthetical_extras(raw_full)

    code = resolve_region_from_open_location(loc)
    if code == UNSPECIFIED and raw:
        mapped = region_label_to_code(raw)
        if mapped and mapped != UNSPECIFIED:
            code = mapped
        else:
            fallback = resolve_region_from_open_location(raw)
            if fallback != UNSPECIFIED:
                code = fallback

    region_raw = raw or raw_full
    display = region_code_to_name(code)
    # Belt-and-suspenders: never persist bracketed notes on vessels.region.
    display = _strip_parenthetical_extras(display) or display
    return display, region_raw


def region_code_to_zone(region: str | None) -> str:
    """Map a region code or display name to a broad trade zone (from trade_regions.zone)."""
    label = str(region or "").strip()
    if not label or label.upper() == UNSPECIFIED:
        return "UNSPECIFIED"
    code = region_label_to_code(label) or label
    zones: dict[str, str] = _load_map().get("region_zones") or {}
    if code in zones and zones[code]:
        return zones[code]
    return code
