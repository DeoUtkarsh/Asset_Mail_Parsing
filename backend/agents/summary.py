"""
AI Summary — aggregate facts from DB rows, then LLM writes a short broker briefing.
Numbers always come from code; the model only narrates provided facts.
"""
from __future__ import annotations

import json
import logging
import re
import asyncio
from collections import Counter
from datetime import datetime, timezone
from typing import Any

from config import settings
from database import supabase
from llm import claude_client
from agents.drafter import REGION_TO_ZONE, ZONE_ORDER
from agents.confidence_score import attachment_needs_review, compute_attachment_confidence

logger = logging.getLogger(__name__)

# ── NVIDIA NIM (legacy — kept for reference, no longer used) ──────────────────
# from openai import AsyncOpenAI
# nvidia_client = AsyncOpenAI(
#     base_url=settings.NVIDIA_API_BASE_URL,
#     api_key=settings.NVIDIA_API_KEY,
# )

ZONE_LABELS: dict[str, str] = {
    "STRAITS/SEA": "Straits / SEA",
    "FAR EAST": "Far East / Southeast Asia",
    "INDIA": "India",
    "AG/MIDDLE EAST": "AG / Middle East (Dubai area)",
    "MED/BLACK SEA": "Med/Black Sea",
    "EUROPE": "Europe",
    "AFRICA": "Africa",
    "AMERICAS": "Americas",
    "OCEANIA": "Oceania",
    "UNSPECIFIED": "Unspecified",
}

ZONE_COLORS: dict[str, str] = {
    "STRAITS/SEA": "#0ea5e9",
    "FAR EAST": "#f59e0b",
    "INDIA": "#10b981",
    "AG/MIDDLE EAST": "#8b5cf6",
    "MED/BLACK SEA": "#6366f1",
    "EUROPE": "#3b82f6",
    "AFRICA": "#ef4444",
    "AMERICAS": "#1d4ed8",
    "OCEANIA": "#ec4899",
    "UNSPECIFIED": "#94a3b8",
}

TYPE_COLORS: dict[str, str] = {
    "tanker": "#8b5cf6",
    "bulk": "#f59e0b",
    "chemical": "#10b981",
    "other specialist": "#0ea5e9",
    "other": "#64748b",
    "unspecified": "#94a3b8",
}


def region_to_zone(region: str | None) -> str:
    if not region:
        return "UNSPECIFIED"
    # Prefer new standard region codes from open-location mapping
    try:
        from region_map import region_code_to_zone, is_standard_region
        if is_standard_region(region) and str(region).strip().upper() != "UNSPECIFIED":
            return region_code_to_zone(region)
    except Exception:
        pass
    r = region.strip().lower()
    for key, zone in REGION_TO_ZONE.items():
        if key in r or r in key:
            return zone
    return "UNSPECIFIED"


def normalize_vessel_type(raw: str | None) -> str:
    t = (raw or "").lower()
    if not t.strip():
        return "unspecified"
    if any(k in t for k in ("tanker", "vlcc", "aframax", "suezmax", "mr ", "handysize tank", "cpp", "product tank")):
        return "tanker"
    if any(k in t for k in ("bulk", "supramax", "panamax", "capesize", "handysize", "kamsarmax", "vloc")):
        return "bulk"
    if any(k in t for k in ("chem", "chemical", "parcel")):
        return "chemical"
    if any(k in t for k in ("container", "lng", "lpg", "gas carrier")):
        return "other specialist"
    return "other"


def _vessel_field(vessel: dict[str, Any], key: str) -> str:
    dd = vessel.get("dynamic_data") or {}
    val = dd.get(key)
    if val is None:
        return ""
    return str(val).strip()


def bucket_opening_date(raw: str | None) -> str:
    low = (raw or "").lower().strip()
    if not low:
        return "unknown"
    if any(w in low for w in ("urgent", "prompt", "asap", "immed", "today", "tomorrow")):
        return "this_week"
    if "next week" in low or "nxt week" in low or "following week" in low:
        return "next_week"
    if re.search(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b", low):
        return "dated"
    if re.search(r"\d{1,2}\s*[-–/]\s*\d{1,2}", low):
        return "dated"
    return "later"


def _parse_dwt_number(raw: str | None) -> float | None:
    if not raw:
        return None
    m = re.search(r"[\d,]+(?:\.\d+)?", str(raw))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def bucket_dwt_size(raw: str | None) -> str:
    n = _parse_dwt_number(raw)
    if n is None or n <= 0:
        return "unknown"
    if n < 10000:
        return "handy"
    if n < 55000:
        return "mr"
    if n < 80000:
        return "lr1_panamax"
    if n < 125000:
        return "lr2_aframax"
    return "suez_plus"


def top_cargo_tokens(vessels: list[dict[str, Any]], limit: int = 5) -> list[tuple[str, int]]:
    counter: Counter[str] = Counter()
    for v in vessels:
        for key in ("cargo_history_combo", "cargo_type", "last_3_cargoes", "last_cargo"):
            raw = _vessel_field(v, key)
            if not raw:
                continue
            for part in re.split(r"[,;/|]+", raw):
                token = part.strip()
                if len(token) >= 3 and not token.isdigit():
                    counter[token[:40]] += 1
    return counter.most_common(limit)


def _pct(part: int, total: int) -> int:
    if total <= 0:
        return 0
    return int(round(100 * part / total))


def _chart_from_counter(
    counter: Counter[str],
    title: str,
    label_map: dict[str, str] | None = None,
    color_map: dict[str, str] | None = None,
    order: list[str] | None = None,
    limit: int = 8,
    drop_keys: set[str] | None = None,
) -> dict[str, Any] | None:
    if not counter:
        return None
    drop = drop_keys or set()
    usable = Counter({k: v for k, v in counter.items() if k not in drop and v > 0})
    if not usable:
        return None
    keys = order or sorted(usable.keys(), key=lambda k: (-usable[k], k))
    items = []
    for key in keys:
        if key not in usable:
            continue
        items.append({
            "label": (label_map or {}).get(key, key.replace("_", " ").title()),
            "value": usable[key],
            "color": (color_map or {}).get(key, "#0369a1"),
        })
        if len(items) >= limit:
            break
    if not items:
        return None
    return {"title": title, "items": items}


def _aggregate_vessel_facts(vessels: list[dict[str, Any]], scope_label: str) -> dict[str, Any]:
    by_zone: Counter[str] = Counter()
    by_type: Counter[str] = Counter()
    opening_buckets: Counter[str] = Counter()
    by_size: Counter[str] = Counter()
    by_direction: Counter[str] = Counter()

    missing = Counter()
    n = len(vessels)

    for v in vessels:
        by_zone[region_to_zone(v.get("region"))] += 1
        vtype = normalize_vessel_type(_vessel_field(v, "vessel_type"))
        by_type[vtype] += 1
        opening_buckets[bucket_opening_date(_vessel_field(v, "opening_date"))] += 1
        by_size[bucket_dwt_size(_vessel_field(v, "dwt_sdwt"))] += 1

        direction = _vessel_field(v, "direction").upper().strip()
        if direction:
            by_direction[direction] += 1
        else:
            missing["direction"] += 1

        if vtype == "unspecified":
            missing["vessel_type"] += 1
        if not _vessel_field(v, "dwt_sdwt"):
            missing["dwt_sdwt"] += 1
        if not _vessel_field(v, "open_location"):
            missing["open_location"] += 1
        if not _vessel_field(v, "opening_date"):
            missing["opening_date"] += 1
        if not (v.get("region") or "").strip():
            missing["region"] += 1

    open_vessels = sum(
        1 for v in vessels
        if _vessel_field(v, "opening_date") or (v.get("region") or "").strip()
    )
    urgency = "high" if opening_buckets.get("this_week", 0) > 0 or opening_buckets.get("next_week", 0) >= max(2, len(vessels) // 3) else "normal"
    if not vessels:
        urgency = "normal"

    cargoes = top_cargo_tokens(vessels)
    top_zones = [
        {"zone": ZONE_LABELS.get(z, z), "count": c}
        for z, c in by_zone.most_common()
        if z != "UNSPECIFIED" and c > 0
    ][:5]

    data_gaps = [
        {"field": k, "missing": v, "pct": _pct(v, n)}
        for k, v in missing.most_common()
        if v > 0
    ]

    charts = []
    zone_chart = _chart_from_counter(
        by_zone, "By trade zone", ZONE_LABELS, ZONE_COLORS, ZONE_ORDER,
        drop_keys={"UNSPECIFIED"} if by_zone.get("UNSPECIFIED", 0) < max(1, n // 5) else set(),
    )
    # Keep UNSPECIFIED in zone chart only when it's a meaningful share
    if not zone_chart:
        zone_chart = _chart_from_counter(
            by_zone, "By trade zone", ZONE_LABELS, ZONE_COLORS, ZONE_ORDER,
        )
    if zone_chart:
        charts.append(zone_chart)

    # Skip type chart when almost everything is unspecified — not useful noise.
    specified_types = n - by_type.get("unspecified", 0)
    if specified_types >= max(2, n * 0.2):
        type_chart = _chart_from_counter(
            by_type, "By vessel type", color_map=TYPE_COLORS,
            order=["tanker", "bulk", "chemical", "other specialist", "other", "unspecified"],
            drop_keys={"unspecified"} if by_type.get("unspecified", 0) > specified_types else set(),
        )
        if type_chart:
            charts.append(type_chart)

    size_known = n - by_size.get("unknown", 0)
    if size_known >= max(2, n * 0.25):
        size_chart = _chart_from_counter(
            by_size, "By DWT size",
            {
                "handy": "Handy (<10k)",
                "mr": "MR (10–55k)",
                "lr1_panamax": "LR1 / Panamax",
                "lr2_aframax": "LR2 / Aframax",
                "suez_plus": "Suezmax+",
                "unknown": "Unknown",
            },
            {
                "handy": "#0ea5e9",
                "mr": "#3b82f6",
                "lr1_panamax": "#8b5cf6",
                "lr2_aframax": "#f59e0b",
                "suez_plus": "#ef4444",
                "unknown": "#94a3b8",
            },
            ["handy", "mr", "lr1_panamax", "lr2_aframax", "suez_plus", "unknown"],
            drop_keys={"unknown"},
        )
        if size_chart:
            charts.append(size_chart)

    open_chart = _chart_from_counter(
        opening_buckets, "Opening timing",
        {
            "this_week": "Urgent / this week",
            "next_week": "Next week",
            "dated": "Specific dates",
            "later": "Later / flexible",
            "unknown": "Not specified",
        },
        {
            "this_week": "#ef4444",
            "next_week": "#f59e0b",
            "dated": "#3b82f6",
            "later": "#10b981",
            "unknown": "#94a3b8",
        },
        ["this_week", "next_week", "dated", "later", "unknown"],
    )
    if open_chart:
        charts.append(open_chart)

    return {
        "scope": scope_label,
        "vessel_count": n,
        "open_vessels": open_vessels,
        "by_zone": dict(by_zone),
        "by_vessel_type": dict(by_type),
        "by_dwt_size": dict(by_size),
        "by_direction": dict(by_direction),
        "opening_buckets": dict(opening_buckets),
        "top_zones": top_zones,
        "top_cargoes": [{"name": name, "count": c} for name, c in cargoes],
        "data_gaps": data_gaps,
        "urgency": urgency,
        "headline_stats": [
            {"label": "Vessels", "value": n},
            {"label": "Open positions", "value": open_vessels},
            {"label": "Zones", "value": sum(1 for z, c in by_zone.items() if c > 0 and z != "UNSPECIFIED")},
            {"label": "Dated opens", "value": opening_buckets.get("dated", 0) + opening_buckets.get("this_week", 0) + opening_buckets.get("next_week", 0)},
        ],
        "charts": charts,
    }


def _load_vessels_by_ids(vessel_ids: list[str] | None) -> list[dict[str, Any]]:
    cols = "id, attachment_id, dynamic_data, region, filename, parent_email_id"
    if vessel_ids:
        if not vessel_ids:
            return []
        rows = (
            supabase.table("vessels_full")
            .select(cols)
            .in_("id", vessel_ids)
            .execute()
        )
        return rows.data or []

    ready = (
        supabase.table("parent_emails")
        .select("id")
        .in_("status", ["ready_for_validation", "drafted"])
        .execute()
    )
    email_ids = [e["id"] for e in (ready.data or [])]
    if not email_ids:
        return []
    rows = (
        supabase.table("vessels_full")
        .select(cols)
        .in_("parent_email_id", email_ids)
        .eq("attachment_is_verified", True)
        .execute()
    )
    return rows.data or []


async def summarize_inbox(email_ids: list[str] | None = None) -> dict[str, Any]:
    emails_q = supabase.table("parent_emails").select("id, status, subject, sender, date_received")
    if email_ids:
        if not email_ids:
            return _empty_response("inbox", "No emails in view.")
        emails_q = emails_q.in_("id", email_ids)
    emails = (emails_q.order("date_received", desc=True).execute()).data or []

    email_id_set = {e["id"] for e in emails}
    attachments: list[dict[str, Any]] = []
    if email_id_set:
        att_rows = (
            supabase.table("attachments")
            .select("id, parent_email_id, filename, status, is_verified")
            .in_("parent_email_id", list(email_id_set))
            .execute()
        ).data or []
        attachments = att_rows

    att_ids = [a["id"] for a in attachments]
    vessels: list[dict[str, Any]] = []
    if att_ids:
        vrows = (
            supabase.table("vessels")
            .select("id, attachment_id, dynamic_data, region")
            .in_("attachment_id", att_ids)
            .execute()
        ).data or []
        vessels = vrows or []

    att_vessel_counts: dict[str, int] = Counter()
    for v in vessels:
        att_vessel_counts[v.get("attachment_id") or ""] += 1

    need_verify = 0
    verified_atts = 0
    for att in attachments:
        vc = att_vessel_counts.get(att["id"], 0)
        if vc >= 1:
            if att.get("is_verified"):
                verified_atts += 1
            else:
                need_verify += 1

    status_counts = Counter(e.get("status") or "unknown" for e in emails)
    vessel_facts = _aggregate_vessel_facts(vessels, "inbox_extracted")

    facts = {
        "scope": "inbox",
        "emails_received": len(emails),
        "attachments_total": len(attachments),
        "vessels_extracted": len(vessels),
        "attachments_need_verification": need_verify,
        "attachments_verified": verified_atts,
        "email_status": dict(status_counts),
        **{k: vessel_facts[k] for k in (
            "by_zone", "by_vessel_type", "opening_buckets", "top_cargoes", "urgency", "charts"
        )},
        "headline_stats": [
            {"label": "Emails", "value": len(emails)},
            {"label": "Vessels extracted", "value": len(vessels)},
            {"label": "Need verification", "value": need_verify},
            {"label": "Attachments", "value": len(attachments)},
        ],
    }

    brief = {
        "context": "email_inbox",
        "emails_received": facts["emails_received"],
        "vessels_extracted": facts["vessels_extracted"],
        "attachments_need_verification": facts["attachments_need_verification"],
        "by_zone": facts["by_zone"],
        "by_vessel_type": facts["by_vessel_type"],
        "urgency": facts["urgency"],
        "email_status": facts["email_status"],
    }
    narrative = await _generate_narrative(brief, "inbox")
    return _pack("inbox", narrative, facts)


async def summarize_vessels(vessel_ids: list[str] | None = None) -> dict[str, Any]:
    """Position List match brief — ranked hot list + incomplete rows (no LLM fluff)."""
    vessels = _load_vessels_by_ids(vessel_ids)
    scope = "selected_vessels" if vessel_ids else "all_vessels"
    facts = _build_match_brief(vessels, scope)
    narrative = _match_brief_copy_text(facts)
    return _pack("vessels", narrative, facts)


def _opening_priority(bucket: str) -> int:
    return {
        "this_week": 100,
        "next_week": 80,
        "dated": 60,
        "later": 20,
        "unknown": 0,
    }.get(bucket, 0)


def _build_match_brief(vessels: list[dict[str, Any]], scope_label: str) -> dict[str, Any]:
    n = len(vessels)
    by_zone: Counter[str] = Counter()
    opening_buckets: Counter[str] = Counter()
    scored: list[tuple[int, dict[str, Any]]] = []
    dead: list[dict[str, Any]] = []

    for v in vessels:
        dd = v.get("dynamic_data") or {}
        name = (_vessel_field(v, "vessel_name") or "—").strip() or "—"
        region = (v.get("region") or "").strip()
        zone = region_to_zone(region)
        by_zone[zone] += 1
        open_date = _vessel_field(v, "opening_date")
        open_loc = _vessel_field(v, "open_location")
        dwt = _vessel_field(v, "dwt_sdwt")
        vtype = _vessel_field(v, "vessel_type")
        bucket = bucket_opening_date(open_date)
        opening_buckets[bucket] += 1

        missing: list[str] = []
        if not vtype or normalize_vessel_type(vtype) == "unspecified":
            missing.append("type")
        if not dwt:
            missing.append("dwt")
        if not open_loc:
            missing.append("open loc")
        if not open_date:
            missing.append("open date")
        if not region or zone == "UNSPECIFIED":
            missing.append("region")

        # Dead weight: too incomplete to match confidently
        if len(missing) >= 2 or ("type" in missing and "open loc" in missing):
            dead.append({
                "vessel_name": name,
                "region": region or "—",
                "missing": missing,
            })

        score = _opening_priority(bucket)
        if region and zone != "UNSPECIFIED":
            score += 15
        if dwt:
            score += 10
        if open_loc:
            score += 10
        if vtype and normalize_vessel_type(vtype) != "unspecified":
            score += 8
        # Prefer actionable opens over blank timing
        if bucket in ("this_week", "next_week", "dated"):
            score += 5
        if len(missing) >= 3:
            score -= 25

        why_parts = []
        if bucket == "this_week":
            why_parts.append("urgent / this week")
        elif bucket == "next_week":
            why_parts.append("next week")
        elif bucket == "dated":
            why_parts.append("dated open")
        if zone != "UNSPECIFIED":
            why_parts.append(ZONE_LABELS.get(zone, zone))
        if dwt:
            why_parts.append(f"DWT {dwt}")

        scored.append((score, {
            "id": v.get("id"),
            "vessel_name": name,
            "region": region or ZONE_LABELS.get(zone, zone),
            "opening_date": open_date or "—",
            "dwt": dwt or "—",
            "why": " | ".join(why_parts) if why_parts else "needs review",
            "score": score,
        }))

    scored.sort(key=lambda x: (-x[0], x[1]["vessel_name"].upper()))
    hot_list = [row for s, row in scored if s >= 40][:8]
    if not hot_list:
        hot_list = [row for _, row in scored[:5]]

    # Prefer dead rows not already in hot list
    hot_names = {h["vessel_name"].upper() for h in hot_list}
    dead_sorted = sorted(
        [d for d in dead if d["vessel_name"].upper() not in hot_names],
        key=lambda d: (-len(d["missing"]), d["vessel_name"].upper()),
    )[:10]

    zone_chips = []
    for z, c in by_zone.most_common():
        if c <= 0:
            continue
        if z == "UNSPECIFIED" and c < max(1, n // 5):
            continue
        zone_chips.append({
            "zone": ZONE_LABELS.get(z, z),
            "count": c,
            "color": ZONE_COLORS.get(z, "#64748b"),
        })

    dated_n = (
        opening_buckets.get("dated", 0)
        + opening_buckets.get("this_week", 0)
        + opening_buckets.get("next_week", 0)
    )
    urgency = "high" if opening_buckets.get("this_week", 0) > 0 or opening_buckets.get("next_week", 0) >= max(2, n // 3) else "normal"

    urgency_line = ""
    if opening_buckets.get("this_week", 0) > 0:
        top = next((z for z in zone_chips if z["zone"] != "Unspecified"), None)
        where = f" in {top['zone']}" if top else ""
        urgency_line = f"{opening_buckets['this_week']} open this week{where} - call first"
    elif opening_buckets.get("next_week", 0) >= 2:
        urgency_line = f"{opening_buckets['next_week']} opens next week - lock interest early"

    open_vessels = sum(
        1 for v in vessels
        if _vessel_field(v, "opening_date") or (v.get("region") or "").strip()
    )

    return {
        "layout": "match_brief",
        "scope": scope_label,
        "vessel_count": n,
        "open_vessels": open_vessels,
        "urgency": urgency,
        "urgency_line": urgency_line,
        "zone_chips": zone_chips,
        "hot_list": hot_list,
        "dead_weight": dead_sorted,
        "dead_weight_count": len(dead),
        "opening_buckets": dict(opening_buckets),
        "headline_stats": [
            {"label": "Vessels", "value": n},
            {"label": "Dated opens", "value": dated_n},
            {"label": "Zones", "value": sum(1 for z, c in by_zone.items() if c > 0 and z != "UNSPECIFIED")},
            {"label": "Hot list", "value": len(hot_list)},
        ],
        "charts": [],
    }


def _match_brief_copy_text(facts: dict[str, Any]) -> str:
    lines: list[str] = []
    if facts.get("urgency_line"):
        lines.append(facts["urgency_line"])
    lines.append("HOT LIST")
    for i, row in enumerate(facts.get("hot_list") or [], 1):
        lines.append(
            f"{i}. {row.get('vessel_name')} | {row.get('region')} | "
            f"{row.get('opening_date')} | {row.get('dwt')} | {row.get('why')}"
        )
    dead_n = facts.get("dead_weight_count") or 0
    if dead_n:
        lines.append(f"DEAD WEIGHT ({dead_n} incomplete - fix before matching)")
        for row in (facts.get("dead_weight") or [])[:8]:
            miss = ", ".join(row.get("missing") or [])
            lines.append(f"- {row.get('vessel_name')}: missing {miss}")
    chips = facts.get("zone_chips") or []
    if chips:
        lines.append(
            "ZONES: " + ", ".join(f"{c['zone']} {c['count']}" for c in chips)
        )
    return "\n".join(lines) if lines else "No vessels in scope."


async def summarize_home(day: str | None = None, tz_name: str = "UTC") -> dict[str, Any]:
    """Home dashboard: pipeline aggregates from DB + short AI narrative.

    Scoped to a single calendar day (default: today in ``tz_name``).
    """
    from collections import defaultdict
    from datetime import datetime, timezone, tzinfo
    from zoneinfo import ZoneInfo

    MANUAL_ENTRIES_MESSAGE_ID = "manual-entries"

    def _resolve_tz(name: str | None) -> tuple[tzinfo, str]:
        raw = (name or "UTC").strip() or "UTC"
        # Windows Python often has no IANA "UTC" key unless tzdata is installed.
        if raw.upper() in ("UTC", "GMT", "ETC/UTC", "Z"):
            return timezone.utc, "UTC"
        try:
            return ZoneInfo(raw), raw
        except Exception:
            return timezone.utc, "UTC"

    tz, tz_name = _resolve_tz(tz_name)

    if day:
        try:
            target = datetime.strptime(day[:10], "%Y-%m-%d").date()
        except ValueError:
            target = datetime.now(tz).date()
    else:
        target = datetime.now(tz).date()
    day_str = target.isoformat()

    emails = (
        supabase.table("parent_emails").select("id, status, message_id, date_received").execute()
    ).data or []
    emails = [e for e in emails if e.get("message_id") != MANUAL_ENTRIES_MESSAGE_ID]

    def _local_day(raw: str | None):
        if not raw:
            return None
        try:
            s = str(raw).replace("Z", "+00:00")
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(tz).date()
        except ValueError:
            try:
                return datetime.strptime(str(raw)[:10], "%Y-%m-%d").date()
            except ValueError:
                return None

    emails = [
        e for e in emails
        if (d := _local_day(e.get("date_received"))) is not None and d == target
    ]

    email_ids = [e["id"] for e in emails]
    ready_ids = {
        e["id"] for e in emails
        if (e.get("status") or "") in ("ready_for_validation", "drafted")
    }

    attachments: list[dict[str, Any]] = []
    if email_ids:
        attachments = (
            supabase.table("attachments")
            .select("id, parent_email_id, status, is_verified, manually_reviewed, raw_text, columns_in_email")
            .in_("parent_email_id", email_ids)
            .execute()
        ).data or []
    att_ids = [a["id"] for a in attachments]

    vessels: list[dict[str, Any]] = []
    if att_ids:
        vessels = (
            supabase.table("vessels")
            .select("id, attachment_id, dynamic_data, region")
            .in_("attachment_id", att_ids)
            .execute()
        ).data or []

    v_by_att: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for v in vessels:
        v_by_att[v.get("attachment_id") or ""].append(v)

    downloaded = sum(1 for a in attachments if (a.get("status") or "").lower() == "done")

    review_count = 0
    for a in attachments:
        # Same rule as inbox Need to review: skip already-verified mails.
        if a.get("is_verified"):
            continue
        vlist = v_by_att.get(a["id"], [])
        conf = compute_attachment_confidence(
            status=a.get("status") or "",
            vessel_count=len(vlist),
            vessels=vlist,
            raw_text=a.get("raw_text"),
            retry_suggested=False,
            manually_reviewed=bool(a.get("manually_reviewed")),
            columns_in_email=a.get("columns_in_email"),
        )
        if attachment_needs_review(
            status=a.get("status") or "",
            confidence_tier=conf.get("confidence_tier"),
            max_unfilled=conf.get("max_unfilled") or 0,
        ):
            review_count += 1

    verified_att_ids = {
        a["id"] for a in attachments
        if a.get("is_verified") and a.get("parent_email_id") in ready_ids
    }
    ready_vessels = [v for v in vessels if v.get("attachment_id") in verified_att_ids]
    positions_ready = len(ready_vessels)
    positions_parsed = len(vessels)

    zones = set()
    for v in ready_vessels:
        z = region_to_zone(v.get("region"))
        if z and z != "UNSPECIFIED":
            zones.add(z)
    zone_count = len(zones)

    readiness_pct = (
        round(100 * positions_ready / positions_parsed) if positions_parsed else 0
    )

    facts = {
        "scope": "home",
        "emails_received": len(emails),
        "attachments_total": len(attachments),
        "attachments_downloaded": downloaded,
        "positions_parsed": positions_parsed,
        "positions_ready": positions_ready,
        "review_count": review_count,
        "zones": zone_count,
        "readiness_pct": readiness_pct,
        "summary_day": day_str,
        "summary_tz": tz_name,
        "headline_stats": [
            {"label": "Emails", "value": len(emails)},
            {"label": "Positions", "value": positions_parsed},
            {"label": "Ready", "value": positions_ready},
            {"label": "To review", "value": review_count},
        ],
    }
    brief = {
        "context": "home",
        "emails_received": len(emails),
        "positions_parsed": positions_parsed,
        "positions_ready": positions_ready,
        "review_count": review_count,
        "zones": zone_count,
        "readiness_pct": readiness_pct,
        "summary_day": day_str,
    }
    # Keep Home refresh snappy: don't hang the whole dashboard on a slow LLM.
    try:
        narrative = await asyncio.wait_for(_generate_narrative(brief, "home"), timeout=4.0)
    except asyncio.TimeoutError:
        logger.warning("[Summary] home narrative timed out — using fallback")
        narrative = _fallback_narrative(brief, "home")
    return _pack("home", narrative, facts)


async def summarize_contacts(contact_ids: list[str] | None = None) -> dict[str, Any]:
    q = supabase.table("broker_contacts").select(
        "id, company, contact_name, email, off_phone, mob_phone, vessel_name, used_fallback"
    )
    if contact_ids is not None:
        if not contact_ids:
            return _empty_response("contacts", "No contacts in view.")
        q = q.in_("id", contact_ids)
    rows = (q.execute()).data or []

    with_email = sum(1 for r in rows if (r.get("email") or "").strip())
    with_phone = sum(1 for r in rows if (r.get("off_phone") or r.get("mob_phone") or "").strip())
    with_vessel = sum(1 for r in rows if (r.get("vessel_name") or "").strip())
    fallback = sum(1 for r in rows if r.get("used_fallback"))
    companies = Counter((r.get("company") or "").strip() for r in rows if (r.get("company") or "").strip())

    company_chart = _chart_from_counter(companies, "Top companies", limit=6)
    charts = [c for c in [company_chart] if c]

    facts = {
        "scope": "contacts",
        "contact_count": len(rows),
        "with_email": with_email,
        "with_phone": with_phone,
        "with_vessel_name": with_vessel,
        "fallback_rows": fallback,
        "headline_stats": [
            {"label": "Contacts", "value": len(rows)},
            {"label": "With email", "value": with_email},
            {"label": "With phone", "value": with_phone},
            {"label": "Fallback rows", "value": fallback},
        ],
        "charts": charts,
        "urgency": "normal",
    }

    brief = {
        "context": "contact_list",
        "contact_count": facts["contact_count"],
        "with_email": with_email,
        "with_phone": with_phone,
        "with_vessel_name": with_vessel,
        "fallback_rows": fallback,
        "top_companies": [{"name": n, "count": c} for n, c in companies.most_common(5)],
    }
    narrative = await _generate_narrative(brief, "contacts")
    return _pack("contacts", narrative, facts)


def _empty_response(context: str, narrative: str) -> dict[str, Any]:
    return _pack(context, narrative, {
        "headline_stats": [],
        "charts": [],
        "urgency": "normal",
    })


def _pack(context: str, narrative: str, facts: dict[str, Any]) -> dict[str, Any]:
    return {
        "context": context,
        "narrative": narrative,
        "facts": {
            **facts,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
    }


def _sanitize_narrative(raw: str, fallback: str) -> str:
    """Drop instruction echo / reasoning; keep broker-facing briefing only."""
    t = (raw or "").strip()
    if not t:
        return fallback
    low = t.lower()
    leak = (
        "we need to produce", "we need to mention", "we should", "we have to",
        "use only the json", "do not invent", "no markdown", "friendly region",
        "3-5 short", "2-4 short", "start with 'hey", 'start with "hey',
        "let's craft", "lets craft", "json facts", "output only",
        "here's a draft", "i'll write", "i will write", "```",
        "emails_received:", "attachments_need_verification:",
        "by_zone:", "by_vessel_type:",
    )
    if any(m in low for m in leak):
        return fallback

    # Prefer structured desk-note (Position List)
    if re.search(r"(?im)^focus\s*:", t) and re.search(r"(?im)^action\s*:", t):
        keep = []
        for ln in t.replace("\r\n", "\n").split("\n"):
            line = ln.strip()
            if re.match(r"(?i)^(focus|gaps|action)\s*:", line):
                keep.append(line[:220])
            if len(keep) >= 3:
                break
        if len(keep) >= 2:
            return "\n".join(keep)

    # Prefer paragraph that starts with Hey (inbox / home / contacts)
    for block in t.replace("\r\n", "\n").split("\n\n"):
        for line in block.split("\n"):
            line = line.strip()
            if line.lower().startswith("hey,") or line.lower().startswith("hey "):
                if not any(m in line.lower() for m in leak):
                    return line[:1200]
    # Any clean line long enough
    for block in t.replace("\r\n", "\n").split("\n\n"):
        line = block.strip().split("\n")[0].strip()
        if len(line) >= 40 and not any(m in line.lower() for m in leak):
            return line[:1200]
    return fallback


async def _generate_narrative(brief: dict[str, Any], context: str) -> str:
    system_prompts = {
        "inbox": (
            "You write ONLY the final briefing paragraph for a shipbroker. "
            "Never repeat instructions, JSON field names, or your reasoning. "
            "3-5 conversational sentences. Start with 'Hey,'. No markdown."
        ),
        "vessels": (
            "You write a shipbroker DESK NOTE for a vessel position list. "
            "Never repeat instructions, JSON keys, or chart counts verbatim. "
            "Do NOT start with Hey. Do NOT pad with filler "
            "(no 'across the board', 'solid options', 'take your time', 'normal pace'). "
            "Output exactly 3 short lines in this shape:\n"
            "Focus: ...\n"
            "Gaps: ...\n"
            "Action: ...\n"
            "Each line max ~18 words. Be blunt and useful."
        ),
        "contacts": (
            "You write ONLY the final briefing paragraph for a shipbroker. "
            "Never repeat instructions, JSON field names, or your reasoning. "
            "2-4 conversational sentences. Start with 'Hey,'. No markdown."
        ),
        "home": (
            "You write ONLY the final briefing paragraph for a shipbroker's daily dashboard. "
            "Never repeat instructions, JSON field names, or your reasoning. "
            "2-3 conversational sentences. Start with 'Hey,'. No markdown."
        ),
    }
    user_hints = {
        "inbox": "Summarize emails received, vessels extracted, verification backlog, geography and vessel types.",
        "vessels": (
            "Desk note only. Use top_zones, opening_buckets, data_gaps, by_dwt_size, "
            "top_cargoes, urgency. Call out missing vessel type / open location if high. "
            "If urgency is high, Action must say prioritize near-term opens."
        ),
        "contacts": "Summarize contact count, email/phone coverage, fallback rows, top companies.",
        "home": "Summarize how many owner emails came in, vessels parsed, vessels verified and ready, zones compiled, and how many still need review. Use the word 'vessels' (never 'positions').",
    }
    system = system_prompts.get(context, system_prompts["vessels"])
    fallback = _fallback_narrative(brief, context)
    try:
        resp = await claude_client.chat.completions.create(
            model=settings.CLAUDE_MODEL,
            messages=[
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": f"{user_hints.get(context, '')}\n\nFACTS:\n{json.dumps(brief, ensure_ascii=False)}",
                },
            ],
            temperature=0.2,
            max_tokens=220 if context == "vessels" else 200,
        )
        text = (resp.choices[0].message.content or "").strip()
        return _sanitize_narrative(text, fallback)
    except Exception as exc:
        logger.warning("[Summary] LLM failed (%s), using fallback", exc)
        return fallback


def _fallback_narrative(brief: dict[str, Any], context: str) -> str:
    if context == "inbox":
        zones = brief.get("by_zone") or {}
        types = brief.get("by_vessel_type") or {}
        zone_bits = ", ".join(
            f"{ZONE_LABELS.get(k, k)} ({v})"
            for k, v in sorted(zones.items(), key=lambda x: -x[1])
            if k != "UNSPECIFIED" and v > 0
        )[:120]
        type_bits = ", ".join(
            f"{v} {k}" for k, v in sorted(types.items(), key=lambda x: -x[1])
            if k != "unspecified" and v > 0
        )[:80]
        need = brief.get("attachments_need_verification", 0)
        tail = " Please verify the unverified attachments before drafting." if need else ""
        geo = f" Main regions: {zone_bits}." if zone_bits else ""
        mix = f" Mix includes {type_bits}." if type_bits else ""
        return (
            f"Hey, {brief.get('emails_received', 0)} emails in view with "
            f"{brief.get('vessels_extracted', 0)} vessels extracted. "
            f"{need} attachments still need verification."
            f"{geo}{mix}{tail}"
        )
    if context == "contacts":
        return (
            f"Hey, {brief.get('contact_count', 0)} contacts on file — "
            f"{brief.get('with_email', 0)} with email and {brief.get('with_phone', 0)} with phone."
        )
    if context == "home":
        review = brief.get("review_count", 0)
        tail = (
            f" {review} still need a quick review."
            if review else " Everything's verified and ready to go."
        )
        return (
            f"Hey, we pulled in {brief.get('emails_received', 0)} owner emails and parsed "
            f"{brief.get('positions_parsed', 0)} vessels into {brief.get('zones', 0)} zones. "
            f"{brief.get('positions_ready', 0)} are verified and ready to send.{tail}"
        )
    count = brief.get("vessel_count", 0)
    gaps = brief.get("data_gaps") or []
    gap_bits = ", ".join(
        f"{g['field'].replace('_', ' ')} {g['pct']}%" for g in gaps[:3]
    )
    zones = brief.get("top_zones") or []
    zone_bits = ", ".join(f"{z['zone']} {z['count']}" for z in zones[:2])
    opens = brief.get("opening_buckets") or {}
    dated = int(opens.get("dated", 0) or 0) + int(opens.get("this_week", 0) or 0) + int(opens.get("next_week", 0) or 0)
    focus = zone_bits or f"{count} vessels"
    gaps_line = gap_bits or "none major"
    action = (
        "Prioritize dated / near-term opens first."
        if brief.get("urgency") == "high" or dated
        else "Fill missing particulars before matching."
    )
    return (
        f"Focus: {focus} - {dated} dated/near-term opens.\n"
        f"Gaps: {gaps_line}.\n"
        f"Action: {action}"
    )
