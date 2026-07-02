"""
Rule-based attachment confidence for Email Extraction Inbox triage (0–100).
Scores pipeline data quality — not raw LLM self-confidence.
"""
from __future__ import annotations

import re
from typing import Any

from column_defs import EMPTY_VALUES

# Core fields brokers expect on a position row (cargo_history_combo often blank — excluded).
KEY_FIELDS = (
    "vessel_name",
    "region",
    "opening_date",
    "vessel_type",
    "dwt_sdwt",
)

TIER_HIGH_MIN = 75
TIER_MEDIUM_MIN = 55

def _filled(val: Any) -> bool:
    if val is None:
        return False
    s = str(val).strip().lower()
    return bool(s) and s not in EMPTY_VALUES


def _tier(score: int) -> str:
    if score >= TIER_HIGH_MIN:
        return "high"
    if score >= TIER_MEDIUM_MIN:
        return "medium"
    return "low"


def compute_attachment_confidence(
    *,
    status: str,
    vessel_count: int,
    vessels: list[dict[str, Any]],
    raw_text: str | None,
    retry_suggested: bool = False,
    manually_reviewed: bool = False,
) -> dict[str, Any]:
    """
    Returns { confidence_score, confidence_tier, confidence_label }.
    tier is high | medium | low | unknown
    """
    st = (status or "").lower()
    if st in ("pending", "extracting", "in_progress"):
        return {
            "confidence_score": None,
            "confidence_tier": "unknown",
            "confidence_label": "—",
            "manually_reviewed": manually_reviewed,
        }
    if st == "error":
        return {
            "confidence_score": 12,
            "confidence_tier": "low",
            "confidence_label": "12 Low" + (" · Reviewed" if manually_reviewed else ""),
            "manually_reviewed": manually_reviewed,
        }

    if vessel_count <= 0:
        base = 28 if st == "done" else 18
        label = f"{base} Low"
        if manually_reviewed:
            label = f"{label} · Reviewed"
        return {
            "confidence_score": base,
            "confidence_tier": "low",
            "confidence_label": label,
            "manually_reviewed": manually_reviewed,
        }

    # --- 1) Field completeness (0–40) ---
    fill_rates: list[float] = []
    for v in vessels:
        dd = v.get("dynamic_data") or {}
        region = v.get("region")
        filled = 0
        for key in KEY_FIELDS:
            val = region if key == "region" else dd.get(key)
            if _filled(val):
                filled += 1
        fill_rates.append(filled / len(KEY_FIELDS))
    completeness = 40 * (sum(fill_rates) / len(fill_rates) if fill_rates else 0)

    # --- 2) Critical presence (0–20) ---
    critical = 8.0
    if vessels:
        with_name = sum(
            1 for v in vessels if _filled((v.get("dynamic_data") or {}).get("vessel_name"))
        )
        critical += 6 * (with_name / len(vessels))
        with_open = sum(
            1
            for v in vessels
            if _filled((v.get("dynamic_data") or {}).get("opening_date"))
            or _filled((v.get("dynamic_data") or {}).get("open_location"))
            or _filled(v.get("region"))
        )
        critical += 6 * (with_open / len(vessels))
    else:
        critical += 4

    # --- 3) Extraction consistency (0–15) ---
    consistency = 12.0 if st == "done" else 6.0
    if retry_suggested:
        consistency -= 3
    if vessel_count >= 1 and st == "done":
        consistency += 3
    consistency = max(0, min(15, consistency))

    # --- 4) Anomaly penalties (subtract up to 15) ---
    penalty = 0.0
    if vessels:
        regions = [str(v.get("region") or "").strip().lower() for v in vessels]
        unspecified = sum(1 for r in regions if not r or r in ("unspecified", "—", "-"))
        penalty += 4 * (unspecified / len(vessels))

        names = [
            str((v.get("dynamic_data") or {}).get("vessel_name") or "").strip().lower()
            for v in vessels
            if _filled((v.get("dynamic_data") or {}).get("vessel_name"))
        ]
        if names:
            dup_ratio = 1 - (len(set(names)) / len(names))
            penalty += 4 * dup_ratio

        sparse_rows = sum(
            1
            for v in vessels
            if not _filled((v.get("dynamic_data") or {}).get("vessel_name"))
            and not _filled(v.get("region"))
        )
        penalty += 3 * (sparse_rows / len(vessels))

    penalty = min(15, penalty)

    # --- 5) Text quality (0–10) ---
    text = (raw_text or "").strip()
    text_len = len(text)
    if text_len < 80:
        text_score = 2
    elif text_len < 300:
        text_score = 5
    elif text_len < 1500:
        text_score = 8
    else:
        text_score = 10
    noise = len(re.findall(r"[^\x20-\x7E\n\r\t]", text))
    if text_len and noise / text_len > 0.15:
        text_score = max(0, text_score - 3)

    raw_total = completeness + critical + consistency - penalty + text_score
    score = int(max(0, min(100, round(raw_total))))
    tier = _tier(score)
    label = f"{score} {tier.capitalize()}"
    if manually_reviewed:
        label = f"{label} · Reviewed"

    return {
        "confidence_score": score,
        "confidence_tier": tier,
        "confidence_label": label,
        "manually_reviewed": manually_reviewed,
    }
