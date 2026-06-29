"""
Fallback parser for broker position lists where column headers are vertical
(PORT OPEN / DATES / DWT / CUB on separate lines) and each vessel is a
5-line block: name, port, date, dwt, cbm.

Common in VIETSEA and similar Southeast Asia tanker circulars.
"""
from __future__ import annotations

import re
from typing import Any

_VESSEL_PREFIX = re.compile(r"^(GT|LS|MV|MT|NS|M/?T)\s+", re.IGNORECASE)
_VESSEL_ANYWHERE = re.compile(r"\b(GT|LS|MV|MT|NS)\s+[A-Z0-9]", re.IGNORECASE)
_DATE_LINE = re.compile(
    r"^\d{1,2}\s+"
    r"(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|"
    r"AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\b",
    re.IGNORECASE,
)
_NUM_LINE = re.compile(r"^[\d,.\s]+$")
_SKIP_LINE = re.compile(
    r"^(CPP/?CHEM|DPP|PORT\s*OPEN|DATES|DWT|CUB|CBM|VESSEL|OPEN)\s*$",
    re.IGNORECASE,
)
_FOOTER_MARKERS = (
    "best regards",
    "chartering manager",
    "save a tree",
    "vi etsea company",
    "vietsea company",
    "@",
    "behavior:url",
)


def _strip_duplicated_html_tail(text: str) -> str:
    """Keep the first plain-text block when .eml body repeats after HTML/CSS."""
    if "behavior:url(#default#VML)" in text:
        text = text.split("behavior:url(#default#VML)")[0]
    return text


def _normalize_lines(text: str) -> list[str]:
    text = _strip_duplicated_html_tail(text or "")
    lines: list[str] = []
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if not line:
            continue
        low = line.lower()
        if any(m in low for m in _FOOTER_MARKERS):
            break
        if _SKIP_LINE.match(line):
            continue
        lines.append(line)
    return lines


def _is_date(line: str) -> bool:
    return bool(_DATE_LINE.match(line.strip()))


def _is_number(line: str) -> bool:
    s = line.strip().replace(",", "").replace(" ", "")
    return bool(s) and _NUM_LINE.match(line.strip()) and any(c.isdigit() for c in s)


def _is_vessel_name(line: str) -> bool:
    s = line.strip()
    if not s or len(s) < 3:
        return False
    if _is_date(s) or _is_number(s):
        return False
    return bool(_VESSEL_PREFIX.match(s))


def looks_like_vertical_tonnage(text: str) -> bool:
    upper = (text or "").upper()
    return (
        "PORT OPEN" in upper
        and "DWT" in upper
        and ("CUB" in upper or "CBM" in upper)
        and bool(_VESSEL_ANYWHERE.search(text or ""))
    )


def parse_vertical_tonnage_vessels(text: str) -> list[dict[str, Any]]:
    """
    Parse vertical tonnage blocks into raw vessel dicts (pre-standardization).
    Returns [] if the layout does not match.
    """
    if not looks_like_vertical_tonnage(text):
        return []

    lines = _normalize_lines(text)
    vessels: list[dict[str, Any]] = []
    i = 0
    while i < len(lines):
        if not _is_vessel_name(lines[i]):
            i += 1
            continue

        name = lines[i]
        i += 1
        port = ""
        date = ""
        dwt = ""
        cbm = ""

        if i < len(lines) and not _is_vessel_name(lines[i]) and not _is_date(lines[i]) and not _is_number(lines[i]):
            port = lines[i]
            i += 1
        if i < len(lines) and _is_date(lines[i]):
            date = lines[i]
            i += 1
        if i < len(lines) and _is_number(lines[i]):
            dwt = lines[i].replace(",", "")
            i += 1
        if i < len(lines) and _is_number(lines[i]):
            cbm = lines[i].replace(",", "")
            i += 1

        vessels.append({
            "vessel_name": name,
            "open_location": port,
            "region": port or "UNSPECIFIED",
            "opening_date": date,
            "dwt_sdwt": dwt,
            "cbm": cbm,
        })

    return vessels


def format_vertical_tonnage_for_llm(text: str) -> str | None:
    """Rewrite vertical blocks as a simple pipe table to help the LLM."""
    vessels = parse_vertical_tonnage_vessels(text)
    if not vessels:
        return None
    header = "VESSEL | PORT OPEN | DATES | DWT | CBM"
    rows = [
        f"{v.get('vessel_name', '')} | {v.get('open_location', '')} | "
        f"{v.get('opening_date', '')} | {v.get('dwt_sdwt', '')} | {v.get('cbm', '')}"
        for v in vessels
    ]
    return header + "\n" + "\n".join(rows)
