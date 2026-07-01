"""
Rule-based parsers for broker emails where LLM extraction fails.
Used as live fallbacks in extraction.py and for format-specific recovery.
"""
from __future__ import annotations

import re
from typing import Any, Callable

_FOOTER_MARKERS = (
    "best regards",
    "look forward to your valuable support",
    "best regard",
    "kind regards",
    "tel:",
    "mobile:",
    "e-mail:",
    "email:",
    "ice id:",
    "ice:",
    "please propose suitable cargoes",
    "companies within",
    "confidentiality",
    "save a tree",
    "behavior:url",
)

_SIGNATURE_LINE = re.compile(
    r"(?:^|\b)(?:tel|mobile|phone|e-?mail|ice)\s*[:]",
    re.IGNORECASE,
)

_SECTION_SKIP = re.compile(
    r"^(LR1|MR\d*|MR|FEAST POSITIONS|ASIA POSITIONS|AG POSITIONS|"
    r"FAR EAST|EUROPE|MIDDLE EAST|STRAITS|MEDITERRANEAN|SEA\s*/\s*ECI|"
    r"ADEN ON LEAVE|LR1\s*\(|AG/AFRICA|S\.E\.ASIA|REGION PICS).*$",
    re.IGNORECASE,
)

_VESSEL_PREFIX = re.compile(
    r"^(?:MT|M/T|MV|MS|FG|PVT|PM|GT|NEW|HIGH|OKEE|RAFFLES|MARINA|TM|NQ|"
    r"ALORA|BAO|ASPIRE|ZEAL|GAMSUNORO|DANSHIP|SAM|CIELO|GLEN|MALED|SNARTH|"
    r"LIKYA|HIKARI|CAROLINE|VIOLETA|MORINA|IRIS|BELLIS|STELLA|JULIA|SAKURA|"
    r"EASTERLY|LILA|JAL|MARINA|YC\s)",
    re.IGNORECASE,
)

_BAD_VESSEL_NAMES = frozenset({
    "HONG GAI", "ZHOUSHAN", "ON SUBS", "NEW BUILD", "AT BERTH", "EX-DD",
    "NORTH SPAIN", "SOUTH SPAIN", "CENTRAL MED", "PORTUGAL", "N2 BOTTLES",
    "IGS", "MED", "CLEAN", "FOSFA", "PART CARGO SPACE - FOSFA",
    "SPORE 21 MARCH / SIKKA 31 MAR", "MOGAS/JET/MOGAS", "PRISTINE TANKS",
    "CARGO HISTORY", "BUILT", "COMMENTS", "DATE", "OPEN", "VESSEL",
    "DEAR ALL,", "DEAR ALL", "GOOD DAY", "ETA YANGPU 02 APR",
    "IMO 2; NEW BUILD", "ON SUBS - CLEAN", "SPECIALIZED – DPP",
    "PLEASE PROPOSE SUITABLE CARGOES.", "FULL SPACE ANY DIR",
    "WE LOOK FORWARD TO YOUR VALUABLE SUPPORT AS ALWAYS!",
})

_PROSE_LINE = re.compile(
    r"heartfelt|ongoing conflict|seafarers|solemnly|families they|"
    r"lost their lives|exports out of|kindly find our|"
    r"look forward to your|valuable support as always",
    re.IGNORECASE,
)

# Line-anchored patterns — avoids false positives like "MT employees" in disclaimers.
_VESSEL_LINE_MARKERS = re.compile(
    r"^(?:"
    r"(?:MT|M/T|MV)\s+[A-Z][A-Za-z0-9 .\-']+|"
    r"[A-Z0-9]+/[A-Z0-9]+-OPEN|"
    r"\d+\.\s+(?:M/T|MT)\s+|"
    r"VESSEL\s*$|"
    r"Vessel Name\s*$"
    r")",
    re.MULTILINE | re.IGNORECASE,
)

_INTRO_LINE = re.compile(
    r"(?:^dear\b|^good\s+day|^kindly\b|^please\s+use\s+email|^please\s+propose|"
    r"positions\s+\d|march\s+20\d{2}|^\[cid:|@|http)",
    re.IGNORECASE,
)

_URL_IN_CELL = re.compile(r"<https?://[^>]+>", re.IGNORECASE)
_MAILTO = re.compile(r"<mailto:[^>]+>", re.IGNORECASE)
_WS = re.compile(r"\s+")


def _clean_cell(s: str) -> str:
    s = _URL_IN_CELL.sub("", s or "")
    s = _MAILTO.sub("", s)
    s = _WS.sub(" ", s).strip()
    return s


_PHONE_LINE = re.compile(r"^\+\d")
_JUNK_VESSEL_NAMES = frozenset({
    "ICE ID", "TBA", "VESSEL", "OPEN", "DATES", "VESSEL NAME", "CARGO HISTORY",
    "BUILT", "COMMENTS", "DATE", "MED", "CLEAN", "NOBL", "FOSFA", "MOBILE NO.",
    "OFFICE NO.", "SINGAPORE", "SIHANOOKVILLE", "MALACCA", "MUTSAMUDU",
    "MOGAS/JET/MOGAS", "PRISTINE TANKS", "UMS+GO/UMS/LSMGO", "DPP/DPP/DPP",
    "NAP/VEG/CHEMS", "NMA/VEG/POP", "CARGO HISTORY", "DIR", "USG",
    "STRAITS", "PROMPT", "WCI", "ECI", "SEA", "IOR", "AG", "F.EAST",
    "MID CHINA", "SOUTH CHINA", "NORTH OF CHINA", "BUSAN", "MAILIAO",
    "SIKKA", "ABIDJAN", "KUANTAN", "TAIWAN", "PENGLAI", "GIBRALTAR",
    "SPECIALIZED", "STAINLESS", "CPP/CHEMS", "SPore", "SUBS", "TC OUT",
    "STAINLESS STEEL", "PORT KLANG", "SINGAPORE", "TANJUNG LANGSAT",
})


def _strip_duplicated_html_tail(text: str) -> str:
    if "behavior:url(#default#VML)" in text:
        text = text.split("behavior:url(#default#VML)")[0]
    return text


def _is_footer_line(line: str) -> bool:
    low = line.lower()
    if any(m in low for m in _FOOTER_MARKERS):
        return True
    if _SIGNATURE_LINE.search(line):
        return True
    if "mailto:" in low:
        return True
    if _PHONE_LINE.match(line.strip()):
        return True
    if "@" in line and ".com" in low and _SIGNATURE_LINE.search(line):
        return True
    return False


def _normalize_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw in (text or "").splitlines():
        line = _clean_cell(raw)
        if not line:
            continue
        if _is_footer_line(line):
            break
        lines.append(line)
    return lines


def _is_prose_line(line: str) -> bool:
    s = (line or "").strip()
    if not s:
        return True
    if _PROSE_LINE.search(s):
        return True
    if len(s) > 70 or len(s.split()) > 10:
        return True
    return False


def _has_structured_vessel_text(raw: str) -> bool:
    """True when raw text contains real vessel rows (not disclaimer boilerplate)."""
    if _VESSEL_LINE_MARKERS.search(raw or ""):
        return True
    if re.search(r"^VESSEL\s*$", raw or "", re.M | re.I) and re.search(
        r"\bDWT\b", raw or "", re.I
    ):
        return True
    return False


def _looks_like_vessel_name(name: str) -> bool:
    s = (name or "").strip()
    if not s or len(s) < 2:
        return False
    if _is_prose_line(s):
        return False
    if _SECTION_SKIP.match(s):
        return False
    if re.match(r"^\d", s):
        return False
    if re.match(r"^[\d.,/\-+$]+$", s.replace(" ", "")):
        return False
    if s.upper() in _JUNK_VESSEL_NAMES:
        return False
    if " FLAG" in s.upper():
        return False
    if re.match(r"^\d{1,2}-[A-Za-z]{3}$", s):
        return False
    if not re.search(r"[A-Za-z]{2,}", s):
        return False
    if s.upper() in _BAD_VESSEL_NAMES:
        return False
    if re.match(r"^(DIR|ANY|MOGAS|NAP|UMS|JET|GO|FO)\b", s, re.I):
        return False
    if re.match(r"^EX-DD", s, re.I) or re.search(r"\bON SUBS\b", s, re.I):
        return False
    return True


def _is_vessel_anchor(line: str, filename_hint: str = "") -> bool:
    """True when a line likely starts a new vessel row in a vertical table."""
    line = (line or "").strip()
    if not line or _INTRO_LINE.search(line):
        return False
    if line.upper() in _BAD_VESSEL_NAMES:
        return False
    if not _looks_like_vessel_name(line):
        return False
    hint = (filename_hint or "").lower()
    if "kosichang" in hint or "yong sheng" in hint:
        if _looks_like_vessel_name(line) and re.match(
            r"^[A-Z0-9][A-Z0-9 .'\-]*$", line
        ):
            return True
    if "christiania" in hint:
        return bool(
            re.search(r"Theresa|Freesia|Tulipa|Lilium", line, re.I)
            or line.upper().startswith("NQ ")
        )
    if re.search(r"Theresa|Freesia|Tulipa|Lilium", line, re.I):
        return True
    if line.upper().startswith("NQ "):
        return True
    if _VESSEL_PREFIX.match(line):
        return True
    if re.match(r"^(PM |NEW BL|TM HAI|HAI XIN|YU YI|ALORA|FG |MS |GLEN )", line, re.I):
        return True
    if len(line.split()) >= 3 and not re.search(
        r"\b(find|today|email|quotes|suitable|propose|positions)\b", line, re.I
    ):
        return True
    if len(line.split()) == 2 and line.upper() not in _BAD_VESSEL_NAMES:
        if re.match(r"^[A-Z][A-Za-z]+ [A-Z][A-Za-z]+", line):
            return True
    return False


def _norm_header(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def parse_vertical_header_table(
    text: str,
    headers: list[str],
    *,
    min_rows: int = 1,
    filename_hint: str = "",
) -> list[dict[str, Any]]:
    """
    Parse vertical HTML tables by anchoring each row on a vessel-name line,
    then collecting the next (n-1) cells until the next anchor.
    """
    lines = _normalize_lines(text)
    n = len(headers)
    norm_headers = [_norm_header(h) for h in headers]

    def _is_header_at(i: int) -> bool:
        if i + n > len(lines):
            return False
        return [_norm_header(lines[i + j]) for j in range(n)] == norm_headers

    header_start = next((idx for idx in range(len(lines)) if _is_header_at(idx)), None)
    if header_start is None:
        return []

    vessels: list[dict[str, Any]] = []
    i = header_start + n
    while i < len(lines):
        if _is_header_at(i) or _SECTION_SKIP.match(lines[i]):
            i += 1
            continue
        if _norm_header(lines[i]) in norm_headers:
            i += 1
            continue
        if not _is_vessel_anchor(lines[i], filename_hint):
            i += 1
            continue

        row = [lines[i]]
        i += 1
        while len(row) < n and i < len(lines):
            if _is_header_at(i) or _SECTION_SKIP.match(lines[i]):
                break
            if _is_vessel_anchor(lines[i], filename_hint) and len(row) >= max(4, n - 2):
                break
            if _norm_header(lines[i]) in norm_headers:
                break
            row.append(lines[i])
            i += 1
        while len(row) < n:
            row.append("")
        if _looks_like_vessel_name(row[0]) and row[0].upper() not in _BAD_VESSEL_NAMES:
            vessels.append(_row_to_vessel(headers, row[:n]))
        continue

    return _dedupe_vessels(vessels) if len(vessels) >= min_rows else []


def _row_to_vessel(headers: list[str], row: list[str]) -> dict[str, Any]:
    cells = [_clean_cell(c) for c in row]
    hnorm = [_norm_header(h) for h in headers]
    data: dict[str, str] = {}

    mapping = {
        "vessel": "vessel_name",
        "vesselname": "vessel_name",
        "imo": "imo",
        "dwt": "dwt_sdwt",
        "sdwt": "dwt_sdwt",
        "dwcc": "dwt_sdwt",
        "gbcapa": "cbm",
        "openport": "open_location",
        "opendate": "opening_date",
        "remark": "remarks",
        "cbm": "cbm",
        "cbm98pct": "cbm",
        "cubic": "cbm",
        "capacity": "cbm",
        "built": "year_built",
        "date": "opening_date",
        "dates": "opening_date",
        "open": "opening_date",
        "port": "open_location",
        "portname": "open_location",
        "portopen": "open_location",
        "where": "open_location",
        "when": "opening_date",
        "area": "region",
        "location": "open_location",
        "last3cgo": "cargo_history_combo",
        "cargohistory": "cargo_history_combo",
        "lastcargo": "cargo_history_combo",
        "lastcargoremarks": "remarks",
        "remarkscurrentstatus": "remarks",
        "comments": "remarks",
        "comment": "remarks",
        "coating": "tank_coating",
        "tanks": "tank_coating",
        "flag": "flag",
        "loa": "other_info",
        "n2igs": "other_info",
    }

    for h, cell in zip(hnorm, cells):
        key = mapping.get(h)
        if not key or not cell or cell in ("-", "–", "—"):
            continue
        if key == "imo" and not re.match(r"^\d{7}$", cell) and "/" in cell:
            data.setdefault("vessel_type", cell)
            continue
        if key == "imo" and re.match(r"^[\d/]+$", cell) and len(cell) < 8:
            data.setdefault("vessel_type", cell)
            continue
        if key in data and data[key]:
            data[key] = f"{data[key]} / {cell}"
        else:
            data[key] = cell

    if "region" in data and "open_location" not in data:
        data["open_location"] = data.pop("region")
    elif "region" in data:
        data.pop("region", None)

    return data


def _dedupe_vessels(vessels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for v in vessels:
        name = (v.get("vessel_name") or "").strip().upper()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(v)
    return out


def parse_samudera_blocks(text: str) -> list[dict[str, Any]]:
    blocks = re.split(r"\+\+\+|\*{3,}", text or "")
    vessels: list[dict[str, Any]] = []
    seen_imos: set[str] = set()
    for block in blocks:
        block = block.strip()
        if not block or "marketing" in block.lower():
            continue
        if "open at" not in block.lower() and "imo" not in block.lower():
            continue
        m = re.search(
            r"(?:\d+\.\s*)?((?:MT|M/T|MV)\s+[A-Z][A-Za-z0-9 .\-']+?)(?:\s*IMO|\s*$|\n)",
            block,
            re.IGNORECASE,
        )
        if not m:
            continue
        v: dict[str, str] = {"vessel_name": _clean_cell(m.group(1))}
        imo = re.search(r"IMO\s*(?:No\.?)?\s*(\d{7})", block, re.I)
        if imo:
            if imo.group(1) in seen_imos:
                continue
            seen_imos.add(imo.group(1))
            v["imo"] = imo.group(1)
        flag = re.search(r"([A-Za-z]+)\s+Flag\s+([\d,]+)\s*DWT", block, re.I)
        if flag:
            v["flag"] = flag.group(1).strip()
            v["dwt_sdwt"] = flag.group(2).replace(",", "")
        cbm = re.search(r"([\d,.]+)\s*CBM", block, re.I)
        if cbm:
            v["cbm"] = cbm.group(1).replace(",", "")
        vtype = re.search(r"(Chemical Tanker[^\n]+)", block, re.I)
        if vtype:
            v["vessel_type"] = vtype.group(1).strip()
        coat = re.search(r"(Stainless[^\n]+|EPOXY[^\n]+)", block, re.I)
        if coat:
            v["tank_coating"] = coat.group(1).strip()
        if re.search(r"valid\s+SIRE", block, re.I):
            v["sire_date"] = "Valid"
        open_m = re.search(r"Open\s+at\s+([^:\n]+):\s*([^\n]+)", block, re.I)
        if open_m:
            v["open_location"] = open_m.group(1).strip()
            v["opening_date"] = open_m.group(2).strip()
        vessels.append(v)
    return vessels


def parse_chem_pool_coded_lines(text: str) -> list[dict[str, Any]]:
    vessels: list[dict[str, Any]] = []
    for raw in (text or "").splitlines():
        line = _clean_cell(raw)
        if not line:
            continue
        m = re.match(
            r"^([A-Z0-9]+/[A-Z0-9]+)-OPEN(?:\s+AT)?\s+(.+)$",
            line,
            re.IGNORECASE,
        )
        if not m:
            continue
        code, rest = m.group(1), m.group(2).strip()
        v: dict[str, str] = {"vessel_name": code, "remarks": rest}
        dwt_m = re.search(r"(\d+)\s*DWT", code + " " + rest, re.I)
        if dwt_m:
            v["dwt_sdwt"] = dwt_m.group(1)
        type_m = re.match(r"^[A-Z0-9]+/([A-Z0-9]+)", code)
        if type_m:
            v["vessel_type"] = type_m.group(1)
        loc_m = re.search(
            r"(?:AT|ON)\s+([A-Z][A-Z\s]+?)(?:\s+ON|\s+AROUND|\s+AROUD|\s+LOOKING)",
            rest,
            re.I,
        )
        if loc_m:
            v["open_location"] = loc_m.group(1).strip()
        date_m = re.search(
            r"(EARLY|MID|END|10-12TH|2HALF)\s+OF\s+[^L]+|"
            r"(\d{1,2}(?:-\d{1,2})?(?:ST|ND|RD|TH)?\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[^\s]*)",
            rest,
            re.I,
        )
        if date_m:
            v["opening_date"] = (date_m.group(0) or "").strip()
        vessels.append(v)
    return vessels


def parse_ne_shipping_numbered(text: str) -> list[dict[str, Any]]:
    text = _strip_duplicated_html_tail(text or "")
    parts = re.split(r"(?=\d+\.\s+(?:M/T|MT)\s+[A-Z])", text, flags=re.I)
    vessels: list[dict[str, Any]] = []
    seen: set[str] = set()
    for block in parts:
        block = block.strip()
        if not block:
            continue
        m = re.match(
            r"\d+\.\s+((?:M/T|MT)\s+[A-Z][A-Za-z0-9 .\-']+)",
            block,
            re.I,
        )
        if not m:
            continue
        v: dict[str, str] = {"vessel_name": _clean_cell(m.group(1))}
        flag = re.search(r"FLAG/([^,\n]+)", block, re.I)
        if flag:
            v["flag"] = flag.group(1).strip()
        built = re.search(r"BUILT/([^\n,]+)", block, re.I)
        if built:
            v["year_built"] = built.group(1).strip()
        dwt = re.search(r"DWT[/\s]+([\d,.]+)", block, re.I)
        if dwt:
            v["dwt_sdwt"] = dwt.group(1).replace(",", "")
        cbm = re.search(r"([\d,.]+)\s*CBM", block, re.I)
        if cbm:
            v["cbm"] = cbm.group(1).replace(",", "")
        draft = re.search(r"DRAFT/([\d.]+)", block, re.I)
        if draft:
            v["draft"] = draft.group(1)
        coat = re.search(r"(SUS\s+316[^\n]+|EPOXY[^\n]+)", block, re.I)
        if coat:
            v["tank_coating"] = coat.group(1).strip()
        if re.search(r"valid\s+SIRE", block, re.I):
            v["sire_date"] = "Valid"
        open_m = re.search(r"OPEN\s*.\s*(.+?)(?:\n\n|DIRECTION|\+\+\+|$)", block, re.I | re.S)
        if open_m:
            open_line = _WS.sub(" ", open_m.group(1)).strip()
            v["opening_date"] = open_line
            v["remarks"] = open_line
        status = re.search(r"(ONSUB|SUBS|TC OUT)", block, re.I)
        if status:
            v["status"] = status.group(1).upper()
        key = re.sub(r"\s+", " ", v["vessel_name"]).upper()
        if key in seen:
            continue
        seen.add(key)
        vessels.append(v)
    return vessels


def parse_hansa_vertical(text: str) -> list[dict[str, Any]]:
    lines = _normalize_lines(text)
    vessels: list[dict[str, Any]] = []
    i = 0
    while i < len(lines):
        m = re.match(r"^(.+?)\s*\((\d+k)\)\s*$", lines[i], re.I)
        if m and i + 3 < len(lines):
            name = m.group(1).strip()
            if name.endswith(":"):
                i += 1
                continue
            dwt = m.group(2).upper()
            loc = lines[i + 1]
            date = lines[i + 2]
            remark = lines[i + 3]
            vessels.append({
                "vessel_name": name,
                "dwt_sdwt": dwt,
                "open_location": loc,
                "opening_date": date,
                "remarks": remark,
            })
            i += 4
            continue
        i += 1
    return vessels


def parse_damico_sections(text: str) -> list[dict[str, Any]]:
    """Parse d'Amico vertical blocks: Dates, Open, Vessel, DWT/CBM, IMO, L3C, Comments."""
    headers = ["Dates", "Open", "Vessel", "DWT/CBM", "IMO", "LAST CARGO(S)", "COMMENTS"]
    lines = _normalize_lines(text)
    vessels: list[dict[str, Any]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not _VESSEL_PREFIX.match(line) and not re.match(
            r"^(CIELO|HIGH\s|ADRIATIC|MARINER|TRADER|TRANSPORT)", line, re.I
        ):
            i += 1
            continue
        if not _looks_like_vessel_name(line):
            i += 1
            continue
        if i < 2:
            i += 1
            continue
        row = [lines[i - 2], lines[i - 1], line]
        for j in range(1, 5):
            if i + j < len(lines) and not _is_header_line(lines[i + j]):
                row.append(lines[i + j])
            else:
                row.append("")
        while len(row) < len(headers):
            row.append("")
        v = _row_to_vessel(headers, row[: len(headers)])
        v["vessel_name"] = line
        if len(row) > 3 and "/" in row[3]:
            dwt, cbm = row[3].split("/", 1)
            v["dwt_sdwt"] = dwt.replace(",", "").strip()
            v["cbm"] = cbm.replace(",", "").strip()
        vessels.append(v)
        i += 1
    return _dedupe_vessels(vessels)


def parse_kosichang_summary(text: str) -> list[dict[str, Any]]:
    """Parse the short vertical summary table; ignore long narrative blocks below."""
    text = _strip_email_noise(text or "")
    cut = re.search(r"\n\s*\d+\)\s*MV\.?", text, re.I)
    if cut:
        text = text[: cut.start()]
    lines = _normalize_lines(text)
    headers = ["VESSEL", "DWCC", "G/B CAPA", "OPEN PORT", "OPEN DATE", "REMARK"]
    n = len(headers)
    norm_headers = [_norm_header(h) for h in headers]

    def _is_header_at(i: int) -> bool:
        if i + n > len(lines):
            return False
        return [_norm_header(lines[i + j]) for j in range(n)] == norm_headers

    header_start = next((idx for idx in range(len(lines)) if _is_header_at(idx)), None)
    if header_start is None:
        return []

    def _kosichang_anchor(line: str) -> bool:
        if not line or _is_prose_line(line):
            return False
        if re.match(r"^(TD|SD|DWT|Port|GRT|HATCH|HOLD|WOG|\(|1\))", line, re.I):
            return False
        if "//" in line or "CRANE" in line.upper():
            return False
        if line.upper() in {"REVERTING", "TC OUT", "REMARK", "OPEN PORT", "OPEN DATE"}:
            return False
        if not re.match(r"^[A-Z][A-Z0-9 .'\-]+$", line):
            return False
        return _looks_like_vessel_name(line)

    vessels: list[dict[str, Any]] = []
    i = header_start + n
    while i < len(lines):
        if _is_header_at(i) or _SECTION_SKIP.match(lines[i]):
            i += 1
            continue
        if _norm_header(lines[i]) in norm_headers:
            i += 1
            continue
        if not _kosichang_anchor(lines[i]):
            i += 1
            continue

        row = [lines[i]]
        i += 1
        while len(row) < n and i < len(lines):
            if _is_header_at(i) or _SECTION_SKIP.match(lines[i]):
                break
            if _kosichang_anchor(lines[i]) and len(row) >= max(4, n - 2):
                break
            if _norm_header(lines[i]) in norm_headers:
                break
            row.append(lines[i])
            i += 1
        while len(row) < n:
            row.append("")
        if _kosichang_anchor(row[0]):
            vessels.append(_row_to_vessel(headers, row[:n]))

    return _dedupe_vessels(vessels)


_CLEARLAKE_HEADERS = ["dwt", "draft", "cubic", "imo", "ice", "open", "date", "comment"]
_CLEARLAKE_SECTION = re.compile(
    r"^(?:Cont\s*/\s*Med|Americas|WAF/SAF|Middle East|India|Far East|"
    r"COMMON EMAILS|CPP Report|DPP Report).*$",
    re.IGNORECASE,
)
_IMO_TYPE_RE = re.compile(r"^[\d,\s/]+$")


def _clearlake_content_lines(text: str) -> list[str]:
    """Non-empty lines only (empty cubic/ice cells omitted in flattened text)."""
    lines: list[str] = []
    for raw in _strip_email_noise(text).splitlines():
        line = _clean_cell(raw)
        if not line:
            continue
        if _is_footer_line(line) and lines:
            break
        lines.append(line)
    return lines


def _parse_clearlake_fields(fields: list[str]) -> dict[str, str]:
    """Map 6-8 trailing cells after vessel name."""
    padded = (fields + [""] * 8)[:8]
    dwt, draft, cubic, imo, ice, open_loc, open_date, comment = padded
    if cubic and _IMO_TYPE_RE.match(cubic) and not imo:
        imo, cubic = cubic, ""
    if ice and _IMO_TYPE_RE.match(ice) and not imo:
        imo, ice = ice, ""
    out: dict[str, str] = {
        "dwt_sdwt": dwt,
        "draft": draft,
        "open_location": open_loc,
        "opening_date": open_date,
        "remarks": comment,
        "region": open_loc,
    }
    if cubic and not _IMO_TYPE_RE.match(cubic):
        out["cbm"] = cubic
    if imo:
        out["vessel_type"] = imo
    return out


def _is_dwt_value_line(line: str) -> bool:
    s = (line or "").replace(",", "").strip()
    return bool(re.match(r"^[\d.]+$", s))


def parse_clearlake_report(text: str) -> list[dict[str, Any]]:
    """Clearlake CPP/DPP vertical reports (multi-section)."""
    lines = _clearlake_content_lines(text)
    vessels: list[dict[str, Any]] = []
    i = 0
    while i < len(lines):
        if (
            i + 7 < len(lines)
            and [_norm_header(lines[i + k]) for k in range(8)] == _CLEARLAKE_HEADERS
        ):
            i += 8
            while i < len(lines):
                if (
                    i + 7 < len(lines)
                    and [_norm_header(lines[i + k]) for k in range(8)] == _CLEARLAKE_HEADERS
                ):
                    break
                if _CLEARLAKE_SECTION.match(lines[i]):
                    i += 1
                    continue
                if i + 1 >= len(lines) or not _is_dwt_value_line(lines[i + 1]):
                    i += 1
                    continue
                name = lines[i]
                if not _looks_like_vessel_name(name):
                    i += 1
                    continue
                i += 1
                fields: list[str] = []
                while i < len(lines) and len(fields) < 8:
                    if _CLEARLAKE_SECTION.match(lines[i]):
                        break
                    if (
                        i + 7 < len(lines)
                        and [_norm_header(lines[i + k]) for k in range(8)] == _CLEARLAKE_HEADERS
                    ):
                        break
                    if (
                        i + 1 < len(lines)
                        and _looks_like_vessel_name(lines[i])
                        and _is_dwt_value_line(lines[i + 1])
                        and len(fields) >= 5
                    ):
                        break
                    fields.append(lines[i])
                    i += 1
                row = _parse_clearlake_fields(fields)
                row["vessel_name"] = name
                vessels.append(row)
            continue
        i += 1
    return _dedupe_vessels(vessels)


_PROSE_OPEN_LINE = re.compile(
    r"(?:M/?T|MV)\s+([A-Za-z0-9 .\-']+?)\s*-\s*Open\s+([^-\n]+?)\s*-\s*([^\n]+)",
    re.IGNORECASE,
)
_PROSE_VESSEL_LINE = re.compile(
    r"(?:^|\n)\s*(?:M/?T|MV)\s+([A-Za-z0-9 .\-']+)\s*(?:\r?\n|$)",
    re.IGNORECASE,
)


def parse_prose_single_vessel(text: str) -> list[dict[str, Any]]:
    """Single-vessel prose blocks (e.g. MT KENJI)."""
    raw = _strip_email_noise(text)
    open_m = _PROSE_OPEN_LINE.search(raw)

    vessel_name = ""
    for m in re.finditer(
        r"(?:^|\n)\s*(?:M/?T|MV)\s+([A-Za-z0-9 .\-']+?)\s*(?:\r?\n)",
        raw,
        re.IGNORECASE,
    ):
        candidate = m.group(1).strip()
        if re.search(r"\bopen\b", candidate, re.I):
            continue
        if len(candidate.split()) <= 4:
            vessel_name = candidate
            break
    if not vessel_name and open_m:
        vessel_name = open_m.group(1).strip()
    if not vessel_name:
        return []

    if not vessel_name.upper().startswith(("MT ", "MV ", "M/T ", "M/V ")):
        vessel_name = f"MT {vessel_name}"

    open_location = open_m.group(2).strip() if open_m else ""
    opening_date = open_m.group(3).strip() if open_m else ""

    built_m = re.search(r"Built\s+(\d{4})", raw, re.IGNORECASE)
    type_m = re.search(r"(?:^|\n)\s*(CPP|DPP|CHEM[^\n,]*)", raw, re.IGNORECASE)
    flag_m = re.search(
        r"(?:DOUBLE\s+HULL\s*/?\s*)?([A-Z][A-Za-z .\-]+(?:KITTS[^\n,]*|NEVIS[^\n,]*|"
        r"INDONESIA|SINGAPORE|MALAYSIA|PANAMA|LIBERIA))",
        raw,
    )
    sdwt_m = re.search(r"SDWT\s+([\d,.]+)", raw, re.IGNORECASE)
    dwt_m = re.search(r"(\d[\d,.]*)\s*DWT", raw, re.IGNORECASE)
    cbm_m = re.search(r"([\d,.]+)\s*CBM", raw, re.IGNORECASE)
    imo_m = re.search(r"IMO\s*(?:No\.?|Number)?\s*[:.]?\s*(\d{7})", raw, re.IGNORECASE)
    open_at_m = re.search(r"Open\s+(?:at\s+)?([^:\n]+):\s*([^\n]+)", raw, re.IGNORECASE)

    if open_at_m and not open_location:
        open_location = open_at_m.group(1).strip()
        opening_date = open_at_m.group(2).strip()

    dwt_val = ""
    if sdwt_m:
        dwt_val = sdwt_m.group(1).strip()
    elif dwt_m:
        dwt_val = dwt_m.group(1).strip()

    if not _looks_like_vessel_name(vessel_name.replace("MT ", "").replace("MV ", "")):
        return []

    vessel: dict[str, Any] = {
        "vessel_name": vessel_name,
        "open_location": open_location,
        "opening_date": opening_date,
        "region": open_location or "UNSPECIFIED",
    }
    if built_m:
        vessel["year_built"] = built_m.group(1)
    if type_m:
        vessel["vessel_type"] = type_m.group(1).strip()
    if flag_m:
        vessel["flag"] = flag_m.group(1).strip()
    if dwt_val:
        vessel["dwt_sdwt"] = dwt_val
    if cbm_m:
        vessel["cbm"] = cbm_m.group(1).strip()
    if imo_m:
        vessel["imo"] = imo_m.group(1)

    return [vessel] if rules_result_trusted([vessel]) else []


def parse_comma_dwt_vessel_lines(text: str) -> list[dict[str, Any]]:
    """Comma-separated one-liners: Mt Tba ,19000 dwt,stst, Jun 06th open north china ..."""
    raw = _strip_email_noise(text)
    vessels: list[dict[str, Any]] = []
    chunks = re.split(r"(?=\b(?:M/?T|MV)\s+)", raw, flags=re.IGNORECASE)
    patterns = (
        re.compile(
            r"(?:M/?T|MV)\s+(.+?)\s*,\s*([\d,]+)\s*dwt\s*,\s*([^,]+)\s*,\s*"
            r"(.+?)\s+(?:full\s+)?space\s+open\s+([^,\n]+)",
            re.IGNORECASE,
        ),
        re.compile(
            r"(?:M/?T|MV)\s+(.+?)\s*,\s*([\d,]+)\s*dwt\s*,\s*([^,]+)\s*,\s*"
            r"(.+?)\s+open\s+([^,\n]+)",
            re.IGNORECASE,
        ),
    )
    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk:
            continue
        matched = None
        for pat in patterns:
            matched = pat.search(chunk)
            if matched:
                break
        if not matched:
            continue
        name = matched.group(1).strip()
        if name.upper() not in ("TBA",) and not _looks_like_vessel_name(name):
            continue
        open_date = matched.group(4).strip().rstrip(",")
        open_loc = matched.group(5).strip().split(",")[0].strip()
        display_name = name if name.upper().startswith("MT") else f"MT {name}"
        vessels.append({
            "vessel_name": display_name,
            "dwt_sdwt": matched.group(2).replace(",", "").strip(),
            "tank_coating": matched.group(3).strip(),
            "opening_date": open_date,
            "open_location": open_loc,
            "region": open_loc,
            "remarks": chunk[:200],
        })
    return _dedupe_vessels(vessels)


def _is_header_line(line: str) -> bool:
    norm = _norm_header(line)
    return norm in {"dates", "open", "vessel", "dwtcbm", "imo", "lastcargos", "comments"}


def _strip_email_noise(text: str) -> str:
    t = _strip_duplicated_html_tail(text or "")
    t = re.sub(r"NkdkJdXPPEBannerStart.*?NkdkJdXPPEBannerEnd", " ", t, flags=re.S | re.I)
    t = re.sub(r"Be Careful With This Message.*?(?=\n\n|\Z)", " ", t, flags=re.S | re.I)
    t = t.replace("\u200d", "").replace("\u200c", "").replace("\ufeff", "")
    t = re.sub(r"\?{3,}", " ", t)
    return t


# (filename substring match, parser callable)
_PARSER_RULES: list[tuple[str, Callable[[str], list[dict[str, Any]]]]] = [
    ("samudera fleet", parse_samudera_blocks),
    ("open position list.eml", parse_chem_pool_coded_lines),
    ("n.e. shipping", parse_ne_shipping_numbered),
    ("carbon positions", lambda t: parse_vertical_header_table(
        t,
        ["VESSEL", "IMO", "DWT", "CBM", "BUILT", "DATE", "PORT", "LAST 3 CGO", "REMARKS/CURRENT STATUS"],
        filename_hint="carbon",
    )),
    ("rcm asia", lambda t: parse_vertical_header_table(
        t,
        ["VESSEL", "OPEN", "AREA", "PORT NAME", "CARGO HISTORY", "BUILT", "DWT", "CUBIC", "COMMENTS"],
        filename_hint="rcm",
    )),
    ("womar", lambda t: parse_vertical_header_table(
        t,
        ["Vessel Name", "DWT", "Capacity", "LOA", "Tanks", "Where", "When", "Last Cargo / Remarks"],
        filename_hint="womar",
    )),
    ("christiania", lambda t: parse_vertical_header_table(
        t,
        ["VESSEL", "SDWT", "CBM 98 PCT", "COATING", "N2/IGS", "OPEN", "DATE", "Comments"],
        filename_hint="christiania",
    )),
    ("hansa tankers", parse_hansa_vertical),
    ("d'amico", parse_damico_sections),
    ("high pool", parse_damico_sections),
    ("kosichang", parse_kosichang_summary),
    ("clearlake", parse_clearlake_report),
]


def filter_trusted_rule_vessels(vessels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop individual mis-parsed rows; keep the rest."""
    return [v for v in vessels if rules_result_trusted([v])]


def rules_result_trusted(vessels: list[dict[str, Any]]) -> bool:
    """False when rule-parser output contains known mis-parse signatures."""
    if not vessels:
        return False
    for v in vessels:
        name = (v.get("vessel_name") or "").strip()
        upper = name.upper()
        if not name or upper in _BAD_VESSEL_NAMES:
            return False
        if _INTRO_LINE.search(name):
            return False
        if upper.startswith("PLEASE ") or upper.startswith("DEAR "):
            return False
        if "POSITIONS" in upper and "MARCH" in upper:
            return False
        if name.startswith("SPORE ") or name.startswith("EX-"):
            return False
        if re.match(r"^\d", name):
            return False
        if _is_prose_line(name):
            return False
        if len(name) > 60:
            return False
    return True


def parse_with_rules(filename: str, raw_text: str) -> list[dict[str, Any]]:
    """Try format-specific rule parsers based on filename."""
    fn = (filename or "").lower()
    text = _strip_email_noise(raw_text)

    if fn == "open position list.eml" or re.search(
        r"^[A-Z0-9]+/[A-Z0-9]+-OPEN", text, re.M | re.I
    ):
        coded = parse_chem_pool_coded_lines(text)
        if coded:
            return coded

    for needle, parser in _PARSER_RULES:
        if needle == "open position list.eml":
            continue
        if needle in fn:
            result = _dedupe_vessels(parser(text))
            if result:
                return result

    prose = parse_prose_single_vessel(text)
    if prose:
        return prose

    comma = parse_comma_dwt_vessel_lines(text)
    if comma:
        return comma

    if "clearlake" not in fn and ("cpp report" in text.lower() or "dpp report" in text.lower()):
        clearlake = parse_clearlake_report(text)
        if clearlake:
            return clearlake

    return []


def _has_recoverable_vessel_data(raw_text: str, filename: str = "") -> bool:
    """True when rule/vertical parsers can extract rows from text (not image-only)."""
    from agents.vertical_tonnage import looks_like_vertical_tonnage, parse_vertical_tonnage_vessels

    raw = raw_text or ""
    if looks_like_vertical_tonnage(raw) and parse_vertical_tonnage_vessels(raw):
        return True
    if parse_with_rules(filename, raw):
        return True
    if re.search(r"PORT\s+OPEN", raw, re.I) and re.search(r"\bDWT\b", raw, re.I):
        if parse_vertical_tonnage_vessels(raw):
            return True
    return False


def is_image_only_attachment(raw_text: str, filename: str = "") -> bool:
    """True when position list is almost certainly an inline image only."""
    raw = raw_text or ""
    fn = (filename or "").lower()

    if _has_recoverable_vessel_data(raw, filename):
        return False

    if "pioneer tanker" in fn and "find attached" in raw.lower():
        return True
    if len(raw.strip()) < 400:
        return True
    has_cid = "cid:" in raw.lower()
    has_vessel_text = _has_structured_vessel_text(raw)
    if has_vessel_text:
        return False
    if has_cid:
        if "maersk" in fn or "handytankers" in fn:
            return True
        return True
    if re.search(r"best regards", raw, re.I) and not has_vessel_text and len(raw) < 3500:
        if "hafnia" in fn or "bahri" in fn or "ncc" in fn:
            return True
    if "bahri" in fn or ("ncc" in fn and "position list" in fn):
        return not has_vessel_text
    return False
