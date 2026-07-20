"""
Rule-based attachment confidence for Email Extraction Inbox triage (0–100).

Score = average % of *applicable* columns filled (columns_in_email from extraction).
Only columns the source email actually contained are counted — empty Direction when
the mail had no direction column does not lower the score.
"""
from __future__ import annotations

from typing import Any

from column_defs import (
    CONFIDENCE_DEFAULT_COLUMNS,
    CONFIDENCE_MAX_UNFILLED,
    EMPTY_VALUES,
    normalize_columns_in_email,
)

# Tier cutoffs — Need to Review = medium/low OR >5 applicable columns unfilled.
TIER_HIGH_MIN = 75
TIER_MEDIUM_MIN = 55

# Values treated as empty for confidence (includes vague region placeholders).
_EMPTY = EMPTY_VALUES | frozenset({"unspecified"})


def _filled(val: Any) -> bool:
    if val is None:
        return False
    s = str(val).strip().lower()
    return bool(s) and s not in _EMPTY


def _tier(score: int) -> str:
    if score >= TIER_HIGH_MIN:
        return "high"
    if score >= TIER_MEDIUM_MIN:
        return "medium"
    return "low"


def _field_value(vessel: dict[str, Any], key: str) -> Any:
    if key == "region":
        return vessel.get("region")
    return (vessel.get("dynamic_data") or {}).get(key)


def _vessel_fill_rate(vessel: dict[str, Any], applicable: list[str]) -> float:
    if not applicable:
        return 0.0
    filled = sum(1 for key in applicable if _filled(_field_value(vessel, key)))
    return filled / len(applicable)


def _vessel_unfilled_count(vessel: dict[str, Any], applicable: list[str]) -> int:
    if not applicable:
        return 0
    return sum(1 for key in applicable if not _filled(_field_value(vessel, key)))


def compute_attachment_confidence(
    *,
    status: str,
    vessel_count: int,
    vessels: list[dict[str, Any]],
    raw_text: str | None,
    retry_suggested: bool = False,
    manually_reviewed: bool = False,
    columns_in_email: list[str] | None = None,
) -> dict[str, Any]:
    """
    Returns { confidence_score, confidence_tier, confidence_label,
              applicable_columns, max_unfilled }.
    tier is high | medium | low | unknown
    """
    del raw_text  # kept for call-site compatibility

    applicable = normalize_columns_in_email(columns_in_email)

    st = (status or "").lower()
    if st in ("pending", "extracting", "in_progress"):
        return {
            "confidence_score": None,
            "confidence_tier": "unknown",
            "confidence_label": "—",
            "manually_reviewed": manually_reviewed,
            "applicable_columns": applicable,
            "max_unfilled": 0,
        }
    if st == "error":
        return {
            "confidence_score": 12,
            "confidence_tier": "low",
            "confidence_label": "12 Low" + (" · Reviewed" if manually_reviewed else ""),
            "manually_reviewed": manually_reviewed,
            "applicable_columns": applicable,
            "max_unfilled": len(applicable),
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
            "applicable_columns": applicable,
            "max_unfilled": len(applicable),
        }

    fill_rates = [_vessel_fill_rate(v, applicable) for v in vessels]
    fill_rate = sum(fill_rates) / len(fill_rates) if fill_rates else 0.0
    max_unfilled = max((_vessel_unfilled_count(v, applicable) for v in vessels), default=0)

    # Linear: 100% of applicable columns filled → 100.
    score = int(max(0, min(100, round(fill_rate * 100))))

    if retry_suggested:
        score = max(0, score - 5)

    if st != "done":
        score = min(score, 70)

    tier = _tier(score)
    label = f"{score} {tier.capitalize()}"
    if manually_reviewed:
        label = f"{label} · Reviewed"

    return {
        "confidence_score": score,
        "confidence_tier": tier,
        "confidence_label": label,
        "manually_reviewed": manually_reviewed,
        "applicable_columns": applicable,
        "max_unfilled": max_unfilled,
    }


def attachment_needs_review(
    *,
    status: str,
    confidence_tier: str | None,
    max_unfilled: int = 0,
) -> bool:
    """True when an attachment belongs in the Need to Review queue."""
    st = (status or "").lower()
    tier = (confidence_tier or "").lower()
    if st == "error":
        return True
    if max_unfilled > CONFIDENCE_MAX_UNFILLED:
        return True
    if tier in ("medium", "low"):
        return True
    return False
