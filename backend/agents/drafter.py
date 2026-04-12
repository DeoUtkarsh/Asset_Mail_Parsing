"""
Agent 4 — Drafter
Generates ONE consolidated HTML email for all validated vessels.
Vessels are grouped into broader trade zones (STRAITS/SEA, FAR EAST, etc.).
The LLM is used only for the short introductory paragraph.
"""
import logging
from collections import defaultdict
from typing import Any, Optional

from openai import AsyncOpenAI
from database import supabase
from config import settings
from sse_manager import sse_manager

logger = logging.getLogger(__name__)

nvidia_client = AsyncOpenAI(
    base_url=settings.NVIDIA_API_BASE_URL,
    api_key=settings.NVIDIA_API_KEY,
)

# ── Region → Broad Zone mapping ───────────────────────────────────────────────

REGION_TO_ZONE: dict[str, str] = {
    # STRAITS / SEA
    "singapore": "STRAITS/SEA", "straits": "STRAITS/SEA",
    "johor": "STRAITS/SEA", "batam": "STRAITS/SEA",
    "bintan": "STRAITS/SEA", "tanjung uban": "STRAITS/SEA",
    "tanjung pelepas": "STRAITS/SEA", "merak": "STRAITS/SEA",
    "surabaya": "STRAITS/SEA", "java": "STRAITS/SEA",
    "indonesia": "STRAITS/SEA", "lombok": "STRAITS/SEA",
    "kalimantan": "STRAITS/SEA", "malaysia": "STRAITS/SEA",
    "kuantan": "STRAITS/SEA", "port klang": "STRAITS/SEA",
    "manila": "STRAITS/SEA", "philippines": "STRAITS/SEA",
    # FAR EAST
    "hong kong": "FAR EAST", "china": "FAR EAST",
    "japan": "FAR EAST", "korea": "FAR EAST",
    "taiwan": "FAR EAST", "chiba": "FAR EAST",
    "tokyo": "FAR EAST", "yokohama": "FAR EAST",
    "yangoon": "FAR EAST", "yangon": "FAR EAST",
    "myanmar": "FAR EAST", "vietnam": "FAR EAST",
    "nha be": "FAR EAST", "hai phong": "FAR EAST",
    "thailand": "FAR EAST", "eci": "FAR EAST",
    "east china": "FAR EAST", "lianyungang": "FAR EAST",
    "geelong": "FAR EAST",
    # INDIA
    "mumbai": "INDIA", "kandla": "INDIA",
    "sikka": "INDIA", "vizag": "INDIA",
    "cochin": "INDIA", "chennai": "INDIA",
    "india": "INDIA", "nhava sheva": "INDIA",
    "kolkata": "INDIA", "haldia": "INDIA",
    # AG / MIDDLE EAST
    "fujairah": "AG/MIDDLE EAST", "uae": "AG/MIDDLE EAST",
    "kuwait": "AG/MIDDLE EAST", "saudi": "AG/MIDDLE EAST",
    "oman": "AG/MIDDLE EAST", "ag": "AG/MIDDLE EAST",
    "jubail": "AG/MIDDLE EAST", "ruwais": "AG/MIDDLE EAST",
    "bahrain": "AG/MIDDLE EAST", "muscat": "AG/MIDDLE EAST",
    # EUROPE
    "rotterdam": "EUROPE", "antwerp": "EUROPE",
    "hamburg": "EUROPE", "europe": "EUROPE",
    "uk": "EUROPE", "amsterdam": "EUROPE",
    # AFRICA
    "durban": "AFRICA", "cape town": "AFRICA",
    "africa": "AFRICA", "mombasa": "AFRICA",
    "dar es salaam": "AFRICA",
    # OCEANIA
    "australia": "OCEANIA", "sydney": "OCEANIA",
    "melbourne": "OCEANIA", "new zealand": "OCEANIA",
}

# Preferred display order
ZONE_ORDER = [
    "STRAITS/SEA", "FAR EAST", "INDIA",
    "AG/MIDDLE EAST", "EUROPE", "AFRICA", "OCEANIA", "UNSPECIFIED",
]

# Leaflet map marker coordinates [lat, lng] per zone
ZONE_COORDS: dict[str, list[float]] = {
    "STRAITS/SEA":    [1.35,   103.82],
    "FAR EAST":       [31.23,  121.47],
    "INDIA":          [20.59,   78.96],
    "AG/MIDDLE EAST": [25.20,   55.27],
    "EUROPE":         [51.50,   -0.13],
    "AFRICA":         [-26.20,  28.05],
    "OCEANIA":        [-33.87, 151.21],
    "UNSPECIFIED":    [0.0,     20.0],
}

# Column display config: (Header, [dynamic_data keys to try in priority order])
COLUMN_MAP = [
    ("VESSEL",       ["vessel_name", "name"]),
    ("DWT",          ["dwt", "sdwt"]),
    ("BUILT",        ["built"]),
    ("COATING",      ["coating", "tank_type", "tank_coating"]),
    ("IMO",          ["imo_type", "imo"]),
    ("OPEN",         ["open_location", "open"]),
    ("OPEN DATE",    ["open_date", "opening_date", "dates", "date"]),
    ("SEEKING",      ["seeking", "basis", "eta_foc"]),
    ("CAPACITY",     ["cargo_tank_cap", "cargo_tank_capacity", "cbm", "dwt_cbm"]),
    ("LAST CARGO",   ["last_3_cargoes", "last_3_cargos", "last_cargos", "last_cargo"]),
    ("SIRE",         ["sire", "sire_valid"]),
    ("L3C",          ["l3c"]),
    ("COMMENTS",     ["comments"]),
]

INTRO_PROMPT = """\
Write one concise paragraph (2–3 sentences) for a shipbroker vessel-position email to a charterer. \
Say that the message consolidates open positions across multiple regions. \
Professional and direct. \
Reply with ONLY that paragraph — no title, no bullets, no markdown, no explanation of how you wrote it."""

INTRO_DEFAULT = (
    "Please find below the latest vessel open positions consolidated "
    "from our network, grouped by trade zone."
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _region_to_zone(region: str) -> str:
    if not region:
        return "UNSPECIFIED"
    r = region.strip().lower()
    for key, zone in REGION_TO_ZONE.items():
        if key in r or r in key:
            return zone
    return "UNSPECIFIED"


def _get_cell(dd: dict, keys: list[str]) -> str:
    for k in keys:
        v = str(dd.get(k) or "").strip()
        if v and v.lower() not in ("unknown", "none", "n/a", "-", ""):
            return v
    return ""


def _is_meaningful_cell(s: str) -> bool:
    v = (s or "").strip()
    if not v:
        return False
    return v.lower() not in ("unknown", "none", "n/a", "-", "—")


def _header_for_column_key(col_key: str) -> str:
    if col_key == "__region__":
        return "REGION"
    if col_key == "signature_emails":
        return "SIGNATURE EMAILS"
    if col_key == "signature_phones":
        return "SIGNATURE PHONES"
    return col_key.replace("_", " ").upper()


def _ordered_grid_column_keys(grid_columns: list[str]) -> list[str]:
    """Match Validate tab: REGION, dynamic keys (excluding duplicate region), then signatures."""
    if not grid_columns:
        return []
    sigs = [k for k in ("signature_emails", "signature_phones") if k in grid_columns]
    dyn = [
        k for k in grid_columns
        if k not in ("signature_emails", "signature_phones", "region")
    ]
    return ["__region__"] + dyn + sigs


def _cell_for_grid_column(vessel: dict, col_key: str) -> str:
    if col_key == "__region__":
        return str(vessel.get("region") or "").strip()
    if col_key == "signature_emails":
        return str(vessel.get("signature_emails") or "").strip()
    if col_key == "signature_phones":
        return str(vessel.get("signature_phones") or "").strip()
    dd = vessel.get("dynamic_data") or {}
    return str(dd.get(col_key) or "").strip()


def _sanitize_intro(raw: str) -> str:
    """Drop model meta / instruction echo; keep a single charterer-facing sentence block."""
    t = (raw or "").strip()
    if not t:
        return INTRO_DEFAULT
    low = t.lower()
    leak = (
        "let's craft", "lets craft", "we need to output", "we should output",
        "single concise paragraph", "2-3 sentences", "2–3 sentences",
        "here's a draft", "here is a draft", "i'll write", "i will write",
        "craft:", "```", "output only", "json output",
    )
    if any(m in low for m in leak):
        return INTRO_DEFAULT
    # First non-empty line / paragraph only
    for block in t.replace("\r\n", "\n").split("\n\n"):
        line = block.strip().split("\n")[0].strip()
        if len(line) >= 25 and not any(m in line.lower() for m in leak):
            return line[:1200]
    return INTRO_DEFAULT


def _build_html_grid(intro_text: str, zone_groups: dict[str, list[dict]], col_keys: list[str]) -> str:
    """Tables use the same columns as the Validate tab (including signatures)."""
    zone_html_parts: list[str] = []
    empty_cell = '<span style="color:#bae6fd">—</span>'

    for zone, vessels in zone_groups.items():
        if not vessels:
            continue

        th = "".join(
            f'<th style="background:#0369a1;color:#e0f2fe;padding:7px 12px;'
            f'text-align:left;font-size:11px;'
            f'border:1px solid #0284c7;font-weight:600;letter-spacing:0.4px">'
            f'{_header_for_column_key(ck)}</th>'
            for ck in col_keys
        )

        rows = ""
        for i, v in enumerate(vessels):
            bg = "#ffffff" if i % 2 == 0 else "#f0f9ff"
            tds = []
            for ck in col_keys:
                raw = _cell_for_grid_column(v, ck)
                display = raw if _is_meaningful_cell(raw) else empty_cell
                wrap = (
                    "normal" if ck in ("signature_emails", "signature_phones") else "nowrap"
                )
                tds.append(
                    f'<td style="padding:7px 12px;font-size:11px;color:#0c4a6e;'
                    f'border:1px solid #e0f2fe;background:{bg};'
                    f'white-space:{wrap};max-width:420px">{display}</td>'
                )
            rows += f"<tr>{''.join(tds)}</tr>"

        zone_html_parts.append(
            f'<div style="margin-bottom:28px">'
            f'<p style="font-size:11px;font-weight:700;color:#0ea5e9;'
            f'letter-spacing:0.8px;text-transform:uppercase;margin:0 0 4px 2px;'
            f'border-left:3px solid #0ea5e9;padding-left:6px">'
            f'{zone}'
            f'</p>'
            f'<table style="width:100%;border-collapse:collapse;border:1px solid #bae6fd;'
            f'border-radius:6px;overflow:hidden">'
            f'<thead><tr>{th}</tr></thead>'
            f'<tbody>{rows}</tbody>'
            f'</table></div>'
        )

    zones_html = "\n".join(zone_html_parts)
    return f"""<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
  body {{ font-family: Arial, sans-serif; font-size: 13px; color: #0c4a6e;
         max-width: 1100px; margin: 0 auto; padding: 24px; background: #f0f9ff; }}
  p {{ margin: 0 0 10px 0; line-height: 1.6; color: #0c4a6e; }}
  tr:hover td {{ background: #e0f2fe !important; }}
</style>
</head>
<body>
  <p>Dear Utkarsh,</p>
  <p>Good day.</p>
  <p>{intro_text}</p>
  <div style="margin: 20px 0 28px 0">
    {zones_html}
  </div>
  <p>Should you require any further details, please do not hesitate to reach out.</p>
  <p>Best Regards</p>
</body>
</html>"""


def _build_html_legacy(intro_text: str, zone_groups: dict[str, list[dict]]) -> str:
    """Build the full HTML email from zone-grouped vessel data."""

    zone_html_parts: list[str] = []

    for zone, vessels in zone_groups.items():
        if not vessels:
            continue

        # Only include columns that have at least one non-empty value in this zone
        active_cols = [
            (hdr, keys)
            for hdr, keys in COLUMN_MAP
            if any(_get_cell(v.get("dynamic_data") or {}, keys) for v in vessels)
        ]

        th = "".join(
            f'<th style="background:#0369a1;color:#e0f2fe;padding:7px 12px;'
            f'text-align:left;font-size:11px;white-space:nowrap;'
            f'border:1px solid #0284c7;font-weight:600;letter-spacing:0.4px">{hdr}</th>'
            for hdr, _ in active_cols
        )

        empty_cell = '<span style="color:#bae6fd">—</span>'
        rows = ""
        for i, v in enumerate(vessels):
            dd = v.get("dynamic_data") or {}
            bg = "#ffffff" if i % 2 == 0 else "#f0f9ff"
            tds = "".join(
                f'<td style="padding:7px 12px;font-size:11px;color:#0c4a6e;'
                f'border:1px solid #e0f2fe;background:{bg};'
                f'white-space:nowrap">{_get_cell(dd, keys) or empty_cell}</td>'
                for _, keys in active_cols
            )
            rows += f"<tr>{tds}</tr>"

        zone_html_parts.append(
            f'<div style="margin-bottom:28px">'
            f'<p style="font-size:11px;font-weight:700;color:#0ea5e9;'
            f'letter-spacing:0.8px;text-transform:uppercase;margin:0 0 4px 2px;'
            f'border-left:3px solid #0ea5e9;padding-left:6px">'
            f'{zone}'
            f'</p>'
            f'<table style="width:100%;border-collapse:collapse;border:1px solid #bae6fd;border-radius:6px;overflow:hidden">'
            f'<thead><tr>{th}</tr></thead>'
            f'<tbody>{rows}</tbody>'
            f'</table></div>'
        )

    zones_html = "\n".join(zone_html_parts)

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
  body {{ font-family: Arial, sans-serif; font-size: 13px; color: #0c4a6e;
         max-width: 1100px; margin: 0 auto; padding: 24px; background: #f0f9ff; }}
  p {{ margin: 0 0 10px 0; line-height: 1.6; color: #0c4a6e; }}
  tr:hover td {{ background: #e0f2fe !important; }}
</style>
</head>
<body>
  <p>Dear Utkarsh,</p>
  <p>Good day.</p>
  <p>{intro_text}</p>
  <div style="margin: 20px 0 28px 0">
    {zones_html}
  </div>
  <p>Should you require any further details, please do not hesitate to reach out.</p>
  <p>Best Regards</p>
</body>
</html>"""


def _build_html(
    intro_text: str,
    zone_groups: dict[str, list[dict]],
    grid_columns: list[str],
) -> str:
    col_keys = _ordered_grid_column_keys(grid_columns)
    if col_keys:
        return _build_html_grid(intro_text, zone_groups, col_keys)
    return _build_html_legacy(intro_text, zone_groups)


# ── Main entry point ──────────────────────────────────────────────────────────

async def run_drafter(
    job_id: str,
    email_id: str,
    vessels: list[dict[str, Any]],
    grid_columns: Optional[list[str]] = None,
) -> tuple[str, list[dict[str, Any]]]:
    """
    Generates one consolidated HTML email for all validated vessels.
    Returns (draft_html, zones_for_map).
    """
    await sse_manager.send(job_id, "drafting_started", {
        "message": f"Generating consolidated draft for {len(vessels)} vessels…",
    })

    # 1 — Group vessels into broad trade zones
    groups: dict[str, list[dict]] = defaultdict(list)
    for v in vessels:
        zone = _region_to_zone(v.get("region") or "")
        groups[zone].append(v)

    ordered: dict[str, list[dict]] = {}
    for z in ZONE_ORDER:
        if z in groups:
            ordered[z] = groups[z]
    for z in groups:
        if z not in ordered:
            ordered[z] = groups[z]

    logger.info(
        "[Drafter] Zones: %s",
        {z: len(v) for z, v in ordered.items()},
    )

    # 2 — Ask LLM for a short intro paragraph only
    intro_text = INTRO_DEFAULT
    try:
        resp = await nvidia_client.chat.completions.create(
            model=settings.NVIDIA_LLM_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You write only the final paragraph for an email body. "
                        "Never describe instructions, steps, or your reasoning. "
                        "No markdown or quotes."
                    ),
                },
                {"role": "user", "content": INTRO_PROMPT},
            ],
            temperature=0.2,
            max_tokens=120,
        )
        intro_text = _sanitize_intro(resp.choices[0].message.content or "")
        logger.info("[Drafter] Intro: %d chars", len(intro_text))
    except Exception as exc:
        logger.warning("[Drafter] Intro LLM failed, using default: %s", exc)

    # 3 — Build HTML email (columns align with Validate when grid_columns sent)
    draft_html = _build_html(intro_text, ordered, grid_columns or [])
    logger.info("[Drafter] HTML email: %d chars", len(draft_html))

    # 4 — Build zone markers for the Leaflet map
    zones_for_map = [
        {
            "name": zone,
            "lat": ZONE_COORDS.get(zone, [0.0, 0.0])[0],
            "lng": ZONE_COORDS.get(zone, [0.0, 0.0])[1],
            "count": len(vlist),
        }
        for zone, vlist in ordered.items()
        if vlist
    ]

    # 5 — Mark email as drafted
    supabase.table("parent_emails").update({"status": "drafted"}).eq("id", email_id).execute()

    return draft_html, zones_for_map
