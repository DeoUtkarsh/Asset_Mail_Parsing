"""
Extract ETA FOC (estimated time of arrival / first open cargo) from broker email text.
"""
from __future__ import annotations

import re
from typing import Any

# e.g. "*  ETA FOC: around 19TH June 2026 in ECI." or "ETA FOC: ECI around 25 MAR 2026"
_ETA_FOC_LINE = re.compile(
    r"ETA\s*FOC\s*:\s*([^\n*]+?)(?:\s*\*|\s*Seeking\b|\r?\n|$)",
    re.IGNORECASE,
)


def parse_eta_foc_from_text(text: str) -> str:
    """Return the first ETA FOC value found in raw email text."""
    m = _ETA_FOC_LINE.search(text or "")
    if not m:
        return ""
    val = re.sub(r"\s+", " ", m.group(1)).strip().rstrip(".")
    if len(val) > 160:
        val = val[:160].rsplit(" ", 1)[0]
    return val


def enrich_vessels_eta_foc(raw_text: str, vessels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Fill missing eta_foc on extracted vessels from attachment raw text.
    For single-vessel bullet lists (e.g. AB OLIVIA), applies the same value to all rows.
    """
    if not vessels:
        return vessels
    attachment_eta = parse_eta_foc_from_text(raw_text)
    if not attachment_eta:
        return vessels
    for vessel in vessels:
        if not str(vessel.get("eta_foc") or "").strip():
            vessel["eta_foc"] = attachment_eta
    return vessels
