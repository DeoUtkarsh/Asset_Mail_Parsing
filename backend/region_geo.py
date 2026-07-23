"""
Seed trade_regions / trade_ports / open_location_aliases from bootstrap data.

After the first successful seed, PostgreSQL is the source of truth —
edit mapping rows in the DB (not files). Re-seed only when tables are empty.
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_JSON_LEGACY = Path(__file__).resolve().parent / "data" / "region_port_map.json"


def ensure_trade_geo_seeded(supabase) -> dict[str, int | bool]:
    """Insert Excel-clone reference rows when trade_regions is empty."""
    existing = supabase.table("trade_regions").select("code").limit(1).execute().data
    if existing:
        _remove_legacy_json()
        return {"skipped": True, "regions": 0, "ports": 0, "aliases": 0}

    from region_geo_seed_data import OPEN_LOCATION_ALIASES, TRADE_PORTS, TRADE_REGIONS

    for i, row in enumerate(TRADE_REGIONS):
        supabase.table("trade_regions").insert({
            "code": row["code"],
            "name": row["name"],
            "zone": row.get("zone") or "",
            "display_order": i,
        }).execute()

    for row in TRADE_PORTS:
        supabase.table("trade_ports").insert({
            "port_name": row["port_name"],
            "country": row.get("country") or "",
            "region_code": row["region_code"],
        }).execute()

    for row in OPEN_LOCATION_ALIASES:
        supabase.table("open_location_aliases").insert({
            "alias": row["alias"],
            "region_code": row["region_code"],
        }).execute()

    try:
        from region_map import clear_region_map_cache
        clear_region_map_cache()
    except Exception:
        pass

    _remove_legacy_json()
    logger.info(
        "Seeded trade geo: %d regions, %d ports, %d aliases",
        len(TRADE_REGIONS),
        len(TRADE_PORTS),
        len(OPEN_LOCATION_ALIASES),
    )
    return {
        "skipped": False,
        "regions": len(TRADE_REGIONS),
        "ports": len(TRADE_PORTS),
        "aliases": len(OPEN_LOCATION_ALIASES),
    }


def _remove_legacy_json() -> None:
    if _JSON_LEGACY.exists():
        try:
            _JSON_LEGACY.unlink()
            logger.info("Removed legacy region_port_map.json (data now in DB)")
        except OSError as exc:
            logger.warning("Could not remove legacy JSON: %s", exc)
