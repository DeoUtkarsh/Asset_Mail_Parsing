"""
AI Summary — aggregate facts from DB rows, then LLM writes a short broker briefing.
Numbers always come from code; the model only narrates provided facts.
"""
from __future__ import annotations

import json
import logging
import re
from collections import Counter
from datetime import datetime, timezone
from typing import Any

from openai import AsyncOpenAI

from config import settings
from database import supabase
from agents.drafter import REGION_TO_ZONE, ZONE_ORDER
from agents.confidence_score import compute_attachment_confidence

logger = logging.getLogger(__name__)

nvidia_client = AsyncOpenAI(
    base_url=settings.NVIDIA_API_BASE_URL,
    api_key=settings.NVIDIA_API_KEY,
)

ZONE_LABELS: dict[str, str] = {
    "STRAITS/SEA": "Straits / SEA",
    "FAR EAST": "Far East / Southeast Asia",
    "INDIA": "India",
    "AG/MIDDLE EAST": "AG / Middle East (Dubai area)",
    "EUROPE": "Europe",
    "AFRICA": "Africa",
    "OCEANIA": "Oceania",
    "UNSPECIFIED": "Unspecified",
}

ZONE_COLORS: dict[str, str] = {
    "STRAITS/SEA": "#0ea5e9",
    "FAR EAST": "#f59e0b",
    "INDIA": "#10b981",
    "AG/MIDDLE EAST": "#8b5cf6",
    "EUROPE": "#3b82f6",
    "AFRICA": "#ef4444",
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


def _chart_from_counter(
    counter: Counter[str],
    title: str,
    label_map: dict[str, str] | None = None,
    color_map: dict[str, str] | None = None,
    order: list[str] | None = None,
    limit: int = 8,
) -> dict[str, Any] | None:
    if not counter:
        return None
    keys = order or sorted(counter.keys(), key=lambda k: (-counter[k], k))
    items = []
    for key in keys:
        if key not in counter:
            continue
        items.append({
            "label": (label_map or {}).get(key, key.replace("_", " ").title()),
            "value": counter[key],
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

    for v in vessels:
        by_zone[region_to_zone(v.get("region"))] += 1
        by_type[normalize_vessel_type(_vessel_field(v, "vessel_type"))] += 1
        opening_buckets[bucket_opening_date(_vessel_field(v, "opening_date"))] += 1

    open_vessels = sum(
        1 for v in vessels
        if _vessel_field(v, "opening_date") or (v.get("region") or "").strip()
    )
    urgency = "high" if opening_buckets.get("this_week", 0) > 0 or opening_buckets.get("next_week", 0) >= max(2, len(vessels) // 3) else "normal"
    if not vessels:
        urgency = "normal"

    cargoes = top_cargo_tokens(vessels)
    charts = []
    zone_chart = _chart_from_counter(
        by_zone, "By trade zone", ZONE_LABELS, ZONE_COLORS, ZONE_ORDER,
    )
    if zone_chart:
        charts.append(zone_chart)
    type_chart = _chart_from_counter(
        by_type, "By vessel type", color_map=TYPE_COLORS,
        order=["tanker", "bulk", "chemical", "other specialist", "other", "unspecified"],
    )
    if type_chart:
        charts.append(type_chart)
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
        "vessel_count": len(vessels),
        "open_vessels": open_vessels,
        "by_zone": dict(by_zone),
        "by_vessel_type": dict(by_type),
        "opening_buckets": dict(opening_buckets),
        "top_cargoes": [{"name": n, "count": c} for n, c in cargoes],
        "urgency": urgency,
        "headline_stats": [
            {"label": "Vessels", "value": len(vessels)},
            {"label": "Open positions", "value": open_vessels},
            {"label": "Zones", "value": sum(1 for z, n in by_zone.items() if n > 0 and z != "UNSPECIFIED")},
            {"label": "Next week", "value": opening_buckets.get("next_week", 0)},
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
    vessels = _load_vessels_by_ids(vessel_ids)
    scope = "selected_vessels" if vessel_ids else "all_verified_vessels"
    facts = _aggregate_vessel_facts(vessels, scope)

    brief = {
        "context": "vessel_position_list",
        "selection": "selected only" if vessel_ids else "full verified list",
        "vessel_count": facts["vessel_count"],
        "open_vessels": facts["open_vessels"],
        "by_zone": facts["by_zone"],
        "by_vessel_type": facts["by_vessel_type"],
        "opening_buckets": facts["opening_buckets"],
        "top_cargoes": facts["top_cargoes"],
        "urgency": facts["urgency"],
    }
    narrative = await _generate_narrative(brief, "vessels")
    return _pack("vessels", narrative, facts)


async def summarize_home() -> dict[str, Any]:
    """Home dashboard: pipeline aggregates from DB + short AI narrative."""
    from collections import defaultdict

    emails = (
        supabase.table("parent_emails").select("id, status").execute()
    ).data or []
    email_ids = [e["id"] for e in emails]
    ready_ids = {
        e["id"] for e in emails
        if (e.get("status") or "") in ("ready_for_validation", "drafted")
    }

    attachments: list[dict[str, Any]] = []
    if email_ids:
        attachments = (
            supabase.table("attachments")
            .select("id, parent_email_id, status, is_verified, manually_reviewed, raw_text")
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
        vlist = v_by_att.get(a["id"], [])
        conf = compute_attachment_confidence(
            status=a.get("status") or "",
            vessel_count=len(vlist),
            vessels=vlist,
            raw_text=a.get("raw_text"),
            retry_suggested=False,
            manually_reviewed=bool(a.get("manually_reviewed")),
        )
        tier = conf.get("confidence_tier")
        st = (a.get("status") or "").lower()
        if tier in ("medium", "low") or st == "error":
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
    }
    narrative = await _generate_narrative(brief, "home")
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
    # Prefer paragraph that starts with Hey
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
            "You write ONLY the final briefing paragraph for a shipbroker. "
            "Never repeat instructions, JSON field names, or your reasoning. "
            "3-5 conversational sentences. Start with 'Hey,'. No markdown."
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
        "vessels": "Summarize vessel count, types, opening timing, regions. Say act fast if urgent.",
        "contacts": "Summarize contact count, email/phone coverage, fallback rows, top companies.",
        "home": "Summarize how many owner emails came in, vessels parsed, vessels verified and ready, zones compiled, and how many still need review. Use the word 'vessels' (never 'positions').",
    }
    system = system_prompts.get(context, system_prompts["vessels"])
    fallback = _fallback_narrative(brief, context)
    try:
        resp = await nvidia_client.chat.completions.create(
            model=settings.NVIDIA_LLM_MODEL,
            messages=[
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": f"{user_hints.get(context, '')}\n\nFACTS:\n{json.dumps(brief, ensure_ascii=False)}",
                },
            ],
            temperature=0.2,
            max_tokens=200,
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
    types = brief.get("by_vessel_type") or {}
    type_bits = ", ".join(f"{v} {k}" for k, v in sorted(types.items(), key=lambda x: -x[1])[:3])
    return (
        f"Hey, {count} vessels in scope"
        + (f" ({type_bits})" if type_bits else "")
        + ". Review openings and regions before drafting."
    )
