"""
Track whether preview edits still differ from the pipeline extraction baseline.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from database import supabase

logger = logging.getLogger(__name__)


def _norm_scalar(val: Any) -> str:
    if val is None:
        return ""
    return str(val).strip()


def _norm_region(region: Any) -> str:
    s = _norm_scalar(region)
    if not s or s.upper() == "UNSPECIFIED":
        return ""
    return s


def vessel_snapshot(vessels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize vessel rows for stable comparison (order-independent)."""
    out: list[dict[str, Any]] = []
    for v in vessels:
        dd = v.get("dynamic_data") or {}
        if isinstance(dd, str):
            try:
                dd = json.loads(dd)
            except json.JSONDecodeError:
                dd = {}
        norm_dd = {k: _norm_scalar(dd.get(k)) for k in sorted(dd.keys())}
        out.append({
            "region": _norm_region(v.get("region")),
            "dynamic_data": norm_dd,
        })

    def sort_key(item: dict[str, Any]) -> tuple[str, str, str, str]:
        dd = item["dynamic_data"]
        return (
            dd.get("vessel_name", "").lower(),
            dd.get("imo", "").lower(),
            dd.get("dwt_sdwt", "").lower(),
            item["region"].lower(),
        )

    out.sort(key=sort_key)
    return out


def _load_vessels(attachment_id: str) -> list[dict[str, Any]]:
    rows = (
        supabase.table("vessels")
        .select("dynamic_data, region")
        .eq("attachment_id", attachment_id)
        .execute()
    )
    return rows.data or []


def save_review_baseline(attachment_id: str, vessels: list[dict[str, Any]] | None = None) -> None:
    baseline = vessel_snapshot(vessels if vessels is not None else _load_vessels(attachment_id))
    supabase.table("attachments").update({
        "review_baseline": baseline,
        "manually_reviewed": False,
    }).eq("id", attachment_id).execute()


def ensure_review_baseline(attachment_id: str) -> None:
    """Capture pre-edit baseline for attachments extracted before this feature."""
    att = (
        supabase.table("attachments")
        .select("review_baseline")
        .eq("id", attachment_id)
        .execute()
    )
    row = (att.data or [None])[0]
    if not row or row.get("review_baseline") is not None:
        return
    save_review_baseline(attachment_id)


def sync_manually_reviewed(attachment_id: str) -> bool:
    """
    Set manually_reviewed from whether current vessels differ from review_baseline.
    Returns the new manually_reviewed value.
    """
    att = (
        supabase.table("attachments")
        .select("review_baseline")
        .eq("id", attachment_id)
        .execute()
    )
    row = (att.data or [None])[0]
    if not row:
        return False

    current = vessel_snapshot(_load_vessels(attachment_id))
    baseline = row.get("review_baseline")
    if baseline is None:
        supabase.table("attachments").update({
            "manually_reviewed": False,
        }).eq("id", attachment_id).execute()
        return False

    reviewed = current != baseline
    supabase.table("attachments").update({
        "manually_reviewed": reviewed,
    }).eq("id", attachment_id).execute()
    logger.info(
        "[Review] attachment %s manually_reviewed=%s",
        attachment_id,
        reviewed,
    )
    return reviewed
