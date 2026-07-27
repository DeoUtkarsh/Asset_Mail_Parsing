"""
Column definitions (PostgreSQL source of truth) and legacy → standard field mapping.
"""
from __future__ import annotations

import logging
import re
import json
from typing import Any

logger = logging.getLogger(__name__)

EMPTY_VALUES = frozenset({
    "", "-", "—", "–", ".", "..", "n/a", "na", "none", "null", "unknown", "tba", "tbc", "tbd",
})

# Keys stored in vessels.dynamic_data (region is vessels.region column).
STANDARD_DYNAMIC_KEYS: list[str] = [
    "company",
    "imo",
    "imo_type",
    "vessel_name",
    "call_sign",
    "year_built",
    "vessel_type",
    "cargo_type",
    "direction",
    "dwt_sdwt",
    "cbm",
    "draft",
    "flag",
    "eta_foc",
    "open_location",
    "opening_date",
    "cargo_history_combo",
    "tank_coating",
    "sire_date",
    "sire_location",
    "cdi_date",
    "cdi_location",
    "remarks",
    "other_info",
    "q88",
    "status",
    # Meta: comma-separated field ids AI/system normalized (not shown as a grid column).
    "ai_normalized",
    # Broker email region text (audit); working vessels.region is derived from open_location.
    "region_raw",
]

LEGACY_KEY_HINTS = frozenset({
    "dwt", "sdwt", "deadweight", "built", "yard_built", "when", "coating", "coat",
    "last_cargo", "cargo_preference", "grade", "last_3_cargoes", "last_3_cargos",
    "last_3_cgo", "last_cargo_s", "l3c", "cargo_history", "open_date", "dates",
    "port_name", "position", "area", "open", "name", "type", "imo_type", "tank_type",
    "cubic", "cub", "cargo_tank_capacity", "remark", "comments", "comment", "remarks",
    "sire", "cdi", "open_status", "imo_number", "sdraft", "sdwt_draft", "region",
    "eta_foc", "eta foc", "eta_foc:",
})

DEFAULT_COLUMN_DEFINITIONS: list[dict[str, Any]] = [
    {"id": "_num", "header": "SR. NO", "display_order": 0, "read_only": True, "storage": "derived"},
    {"id": "vessel_name", "header": "VESSEL NAME", "display_order": 1, "read_only": False, "storage": "dynamic_data"},
    {"id": "dwt_sdwt", "header": "DWT/SDWT", "display_order": 2, "read_only": False, "storage": "dynamic_data"},
    {"id": "year_built", "header": "YEAR BUILT", "display_order": 3, "read_only": False, "storage": "dynamic_data"},
    {"id": "tank_coating", "header": "TANK COATING", "display_order": 4, "read_only": False, "storage": "dynamic_data"},
    {"id": "imo", "header": "IMO", "display_order": 5, "read_only": False, "storage": "dynamic_data"},
    {"id": "imo_type", "header": "IMO TYPE", "display_order": 6, "read_only": False, "storage": "dynamic_data"},
    {"id": "region", "header": "REGION", "display_order": 7, "read_only": False, "storage": "region"},
    {"id": "opening_date", "header": "OPENING DATE", "display_order": 8, "read_only": False, "storage": "dynamic_data"},
    {"id": "open_location", "header": "OPEN LOCATION", "display_order": 9, "read_only": False, "storage": "dynamic_data"},
    {"id": "direction", "header": "DIRECTION", "display_order": 10, "read_only": False, "storage": "dynamic_data"},
    {"id": "cbm", "header": "CBM/CUBIC METER", "display_order": 11, "read_only": False, "storage": "dynamic_data"},
    {"id": "cargo_history_combo", "header": "LAST 3 CARGOES", "display_order": 12, "read_only": False, "storage": "dynamic_data"},
    {"id": "company", "header": "COMPANY", "display_order": 13, "read_only": False, "storage": "dynamic_data"},
    {"id": "call_sign", "header": "CALL SIGN", "display_order": 14, "read_only": False, "storage": "dynamic_data"},
    {"id": "vessel_type", "header": "VESSEL TYPE", "display_order": 15, "read_only": False, "storage": "dynamic_data"},
    {"id": "cargo_type", "header": "CARGO TYPE", "display_order": 16, "read_only": False, "storage": "dynamic_data"},
    {"id": "draft", "header": "DRAFT", "display_order": 17, "read_only": False, "storage": "dynamic_data"},
    {"id": "flag", "header": "FLAG", "display_order": 18, "read_only": False, "storage": "dynamic_data"},
    {"id": "eta_foc", "header": "ETA FOC", "display_order": 19, "read_only": False, "storage": "dynamic_data"},
    {"id": "sire_date", "header": "SIRE DATE", "display_order": 20, "read_only": False, "storage": "dynamic_data"},
    {"id": "sire_location", "header": "SIRE LOCATION", "display_order": 21, "read_only": False, "storage": "dynamic_data"},
    {"id": "cdi_date", "header": "CDI DATE", "display_order": 22, "read_only": False, "storage": "dynamic_data"},
    {"id": "cdi_location", "header": "CDI LOCATION", "display_order": 23, "read_only": False, "storage": "dynamic_data"},
    {"id": "remarks", "header": "REMARKS", "display_order": 24, "read_only": False, "storage": "dynamic_data"},
    {"id": "other_info", "header": "EXTRA INFO", "display_order": 25, "read_only": True, "storage": "dynamic_data"},
    {"id": "q88", "header": "Q88 AVAILABLE", "display_order": 26, "read_only": False, "storage": "dynamic_data"},
    {"id": "attachments", "header": "ATTACHMENTS", "display_order": 27, "read_only": True, "storage": "derived"},
    {"id": "status", "header": "STATUS", "display_order": 28, "read_only": False, "storage": "dynamic_data"},
]

# Default visible columns used for attachment confidence (matches POSITION_LIST_SUMMARY
# in frontend minus SR. NO). Score ≈ % of applicable columns filled per vessel.
CONFIDENCE_DEFAULT_COLUMNS: tuple[str, ...] = (
    "vessel_name",
    "dwt_sdwt",
    "year_built",
    "tank_coating",
    "imo",
    "imo_type",
    "region",
    "opening_date",
    "open_location",
    "direction",
    "cbm",
    "cargo_history_combo",
    "company",
)

# Max applicable columns unfilled before forcing Need to Review.
CONFIDENCE_MAX_UNFILLED = 5


def normalize_columns_in_email(raw: list | None) -> list[str]:
    """Filter/normalize LLM columns_in_email; fall back to all defaults when absent."""
    allowed = set(CONFIDENCE_DEFAULT_COLUMNS)
    if not raw:
        return list(CONFIDENCE_DEFAULT_COLUMNS)
    out: list[str] = []
    for item in raw:
        key = str(item or "").strip().lower().replace(" ", "_")
        if key in allowed and key not in out:
            out.append(key)
    return out if out else list(CONFIDENCE_DEFAULT_COLUMNS)

IMO_NUMBER_RE = re.compile(r"^\d{7}$")
IMO_EMBEDDED_RE = re.compile(r"\b(\d{7})\b")


def company_name_from_filename(filename: str) -> str:
    """Broker / list label from the source .eml attachment filename."""
    return re.sub(r"\.eml$", "", (filename or "").strip(), flags=re.I)


_GENERIC_COMPANY_RE = re.compile(
    r"^(?:attachment_\d{3}|vessel\s+open\s+position(?:_\d+)?)$",
    re.I,
)
# Desk / department / role lines — never the owner/operator company.
_DEPT_OR_DESK_RE = re.compile(
    r"^(?:chartering|operations?|ops|commercial|trading|sales|marketing|tech(?:nical)?"
    r"|fleet|bunker|agency|accounts?|admin(?:istration)?|management)\s*"
    r"(?:dept\.?|department|desk|team|office)?$"
    r"|^(?:best\s+regards|kind\s+regards|thanks|thank\s+you|dear\b.*)$",
    re.I,
)
_COMPANY_LINE_RE = re.compile(
    r"\b(?:ltd\.?|limited|pte\.?\s*ltd|inc\.?|corp\.?|corporation|gmbh|s\.?a\.?|b\.?v\.?|llc|llp)\b",
    re.I,
)
_COMPANY_HINT_RE = re.compile(
    r"\b(?:shipping|tankers?|maritime|logistics|freight|brokers?|energy|petroleum|"
    r"chem(?:ical)?s?|carriers?|line|managers?)\b",
    re.I,
)
_PERSON_NAME_RE = re.compile(
    r"^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$",
)
_COMPANY_JUNK_RE = re.compile(
    r"(?:"
    r"^subject\s*:"
    r"|^please\s+(?:propose|find|advise|revert)"
    r"|^dear\b"
    r"|^good\s+day\b"
    r"|^specialized\b"
    r"|^type\s*:"
    r"|^(?:yard|built|flag|class|imo|dwt|sdwt|cbm|cubic|open|status)\s*/?\s*(?:built|yard)?\s*:"
    r"|\b(?:position\s+lists?|open\s+tonnage|open\s+positions?|spot\s+position)\b"
    r"|\bpositions?\b.*\b(?:20\d{2}|\d{1,2}\s*[A-Za-z]{3,9}|\d{1,2}[./-]\d{1,2})"
    r"|\b(?:dwt|sdwt|blt|built)\b.*\b(?:open|range)\b"
    r"|^(?:large|small|handy|mr|lr\s?\d?|aframax|suezmax|vlcc)\s+tankers?\b"
    r"|\bgas\s+carrier\b"
    r")"
    ,
    re.I,
)
_CARGO_SLASH_RE = re.compile(
    r"^[A-Za-z]{2,12}(?:\s*/\s*[A-Za-z]{2,12}){1,6}$",
)
_VESSEL_LINE_AS_COMPANY_RE = re.compile(
    r"^(?:mt|m/t|m\.t\.|mv|m\.v\.)\s+\S+.*\b\d",
    re.I,
)


def _clean_company_candidate(name: str) -> str:
    """Strip mail prefixes that sometimes leak into company (FM:, Subject:)."""
    s = (name or "").strip()
    s = re.sub(r"^(?:fm|from|re)\s*:\s*", "", s, flags=re.I).strip()
    s = re.sub(r"^subject\s*:\s*", "", s, flags=re.I).strip()
    s = re.sub(r"^[\s\-–—:|]+", "", s).strip()
    return s


_TITLE_POSITION_TAIL_RE = re.compile(
    r"\s*[-–—|:]\s*(?:"
    r"position\s*lists?|positions?|open\s+tonnage|open\s+positions?|"
    r"fleet(?:\s+list)?|tonnage|ww|weekly|daily|coastal|spot"
    r").*$",
    re.I,
)
_TITLE_POSITION_INLINE_RE = re.compile(
    r"\s+(?:and\s+)?(?:coastal\s+)?(?:position\s*lists?|positions?|open\s+tonnage|open\s+positions?)\b.*$",
    re.I,
)
_TITLE_TRAILING_DATE_RE = re.compile(
    r"\s+(?:"
    r"\d{1,2}[./-]\d{1,2}[./-]\d{2,4}"
    r"|\d{1,2}\s+[A-Za-z]{3,9}\.?\s*'?\d{2,4}"
    r"|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{2,4}"
    r"|20\d{2}"
    r")\s*$",
    re.I,
)

_FREE_EMAIL_DOMAINS = frozenset({
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com",
    "icloud.com", "me.com", "aol.com", "protonmail.com", "proton.me",
    "mail.com", "yandex.com", "gmx.com", "qq.com", "163.com",
})

# High-confidence domain → company (Contact List often already knows these).
_DOMAIN_TO_COMPANY = {
    "shell.com": "Shell",
    "bp.com": "BP",
    "exxonmobil.com": "ExxonMobil",
    "chevron.com": "Chevron",
    "totalenergies.com": "TotalEnergies",
    "total.com": "TotalEnergies",
    "eni.com": "Eni",
    "equinor.com": "Equinor",
    "stolt.com": "Stolt Tankers",
    "stolt-nielsen.com": "Stolt Tankers",
    "hafnia.com": "Hafnia",
    "ardmoreshipping.com": "Ardmore Shipping",
    "womar.com": "Womar Logistics",
    "maersk.com": "Maersk",
    "traffigure.com": "Trafigura",
    "vitol.com": "Vitol",
    "gunvor.com": "Gunvor",
    "mercuria.com": "Mercuria",
}

_EMAIL_DOMAIN_RE = re.compile(r"@([a-z0-9.-]+\.[a-z]{2,})", re.I)


def clean_company_from_title(title: str) -> str:
    """Turn a subject / attachment title into a usable company label.

    e.g. 'Shell Eastern Chemical and Coastal Positions 24 Jul 2026'
      → 'Shell Eastern Chemical and Coastal'
    """
    s = _clean_company_candidate(title)
    if not s:
        return ""
    s = _TITLE_POSITION_TAIL_RE.sub("", s).strip()
    s = _TITLE_POSITION_INLINE_RE.sub("", s).strip()
    s = _TITLE_TRAILING_DATE_RE.sub("", s).strip()
    s = re.sub(r"\s{2,}", " ", s).strip(" -–—|/,")
    return s


def is_generic_company_name(name: str) -> bool:
    s = _clean_company_candidate(name)
    if not s or len(s) < 3:
        return True
    if _GENERIC_COMPANY_RE.match(s):
        return True
    if _DEPT_OR_DESK_RE.match(s):
        return True
    if _COMPANY_JUNK_RE.search(s):
        return True
    if _VESSEL_LINE_AS_COMPANY_RE.match(s):
        return True
    # Cargo grade lists like NAP/VEG/CHEMS (not a company).
    if _CARGO_SLASH_RE.match(s) and not _COMPANY_LINE_RE.search(s):
        return True
    # Sentences / paragraphs mistakenly used as company.
    if len(s) > 70:
        return True
    if s.endswith((".", "?", "!")) and len(s) > 35:
        return True
    if s.count(" ") >= 12:
        return True
    # Person-looking names without corporate keywords (e.g. "Rohan Kalantre").
    if _PERSON_NAME_RE.match(s) and not _COMPANY_LINE_RE.search(s) and not _COMPANY_HINT_RE.search(s):
        return True
    return False


def company_from_subject(subject: str) -> str:
    cleaned = clean_company_from_title(subject)
    if cleaned and not is_generic_company_name(cleaned):
        return cleaned
    # Short brand left after aggressive clean (e.g. only "Shell")
    if cleaned and len(cleaned) >= 3 and not _COMPANY_JUNK_RE.search(cleaned):
        if _COMPANY_HINT_RE.search(cleaned) or len(cleaned.split()) <= 4:
            return cleaned
    return ""


def company_from_email_domains(text: str) -> str:
    """Infer company from @domain addresses in the body (same signal Contact List uses)."""
    from collections import Counter

    counts: Counter[str] = Counter()
    for m in _EMAIL_DOMAIN_RE.finditer(text or ""):
        dom = m.group(1).lower().lstrip(".")
        if not dom or dom in _FREE_EMAIL_DOMAINS:
            continue
        # daniel.kc.tan@sg.shell.com → try shell.com / sg.shell.com
        parts = dom.split(".")
        mapped = None
        for i in range(len(parts) - 1):
            candidate = ".".join(parts[i:])
            if candidate in _DOMAIN_TO_COMPANY:
                mapped = _DOMAIN_TO_COMPANY[candidate]
                break
        if mapped:
            counts[mapped] += 1
            continue
        if dom in _DOMAIN_TO_COMPANY:
            counts[_DOMAIN_TO_COMPANY[dom]] += 1
            continue
        label = parts[0]
        if len(label) >= 3 and label not in ("mail", "email", "smtp", "www", "corp", "group"):
            counts[label.title()] += 1
    if not counts:
        return ""
    return counts.most_common(1)[0][0]


def consensus_broker_company(companies: list[str] | None) -> str:
    """Most common non-generic company already on contacts for this attachment."""
    from collections import Counter

    counts: Counter[str] = Counter()
    for raw in companies or []:
        for part in re.split(r"\s*,\s*", str(raw or "")):
            cleaned = _clean_company_candidate(part)
            if cleaned and not is_generic_company_name(cleaned):
                counts[cleaned] += 1
    if not counts:
        return ""
    return counts.most_common(1)[0][0]


def strip_parenthetical_extras(text: str | None) -> str:
    """Remove bracketed notes: 'Hub zone (open-position term)' → 'Hub zone'."""
    s = str(text or "").strip()
    if not s:
        return ""
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"\s*\([^)]*\)", "", s).strip()
        s = re.sub(r"\s*\[[^\]]*\]", "", s).strip()
    return re.sub(r"\s{2,}", " ", s).strip()


def _parse_mail_display_name(header: str) -> str:
    header = (header or "").strip()
    if not header:
        return ""
    m = re.match(r'^"([^"]+)"\s*<', header)
    if m:
        name = m.group(1).strip()
        if "@" not in name:
            return name
    m = re.match(r"^([^<]+)<", header)
    if m:
        name = m.group(1).strip().strip('"')
        if name and "@" not in name:
            return name
    return ""


def _company_candidates_from_text(raw_text: str) -> list[str]:
    """Collect likely company lines from letterhead (head) + signature (tail)."""
    lines = [ln.strip() for ln in (raw_text or "").splitlines() if ln.strip()]
    if not lines:
        return []
    head = lines[:20]
    tail = lines[-30:]
    seen: set[str] = set()
    out: list[str] = []
    for ln in head + tail:
        if len(ln) < 4 or len(ln) > 140:
            continue
        if "@" in ln or "http" in ln.lower() or "www." in ln.lower():
            continue
        if re.match(r"^[_\-=•·]+$", ln):
            continue
        if is_generic_company_name(ln):
            continue
        if _COMPANY_LINE_RE.search(ln) or _COMPANY_HINT_RE.search(ln):
            cleaned = _clean_company_candidate(ln)
            if not cleaned or is_generic_company_name(cleaned):
                continue
            key = cleaned.lower()
            if key not in seen:
                seen.add(key)
                out.append(cleaned)
    return out


def _company_from_raw_signature(raw_text: str) -> str:
    """Best company-like line from letterhead/signature candidates."""
    cands = _company_candidates_from_text(raw_text)
    return cands[0] if cands else ""


def _match_company_from_vessel_name(vessel_name: str, companies: list[str]) -> str:
    clean = re.sub(r"^(?:mt|m/t|mv|m\.v\.)\s+", "", (vessel_name or "").strip(), flags=re.I)
    clean_upper = clean.upper()
    for company in companies:
        token = (company or "").split()[0].upper()
        if len(token) >= 4 and token in clean_upper:
            return company.strip()
    return ""


def resolve_vessel_company(
    filename: str,
    *,
    mail_from: str = "",
    parent_sender: str = "",
    raw_text: str = "",
    mail_subject: str = "",
    vessel_name: str = "",
    llm_company: str = "",
    broker_companies: list[str] | None = None,
    ai_picked_company: str = "",
) -> str:
    """Best-effort owner/operator company label for one vessel row.

    Prefer AI-picked company (signature + body candidates) when provided.
    Also use subject brand, @domain addresses, and Contact List consensus —
    the same signals that already work for contacts — so position rows stay in sync.
    Never keep department desks, person names, raw subjects, or sentence junk.
    """
    ai_picked = _clean_company_candidate(ai_picked_company)
    if _has_value(ai_picked) and not is_generic_company_name(ai_picked):
        return ai_picked

    if vessel_name and broker_companies:
        matched = _match_company_from_vessel_name(vessel_name, broker_companies)
        matched = _clean_company_candidate(matched)
        if matched and not is_generic_company_name(matched):
            return matched

    # Contact List already resolved company for people on this mail
    consensus = consensus_broker_company(broker_companies)
    if consensus:
        return consensus

    from_domain = company_from_email_domains(raw_text)
    if from_domain and not is_generic_company_name(from_domain):
        return from_domain

    from_subject = company_from_subject(mail_subject)
    if from_subject:
        return from_subject

    signature = _clean_company_candidate(_company_from_raw_signature(raw_text))
    if signature and not is_generic_company_name(signature):
        return signature

    llm = _clean_company_candidate(llm_company)
    if _has_value(llm) and not is_generic_company_name(llm):
        # LLM sometimes echoes the full subject — clean it
        llm_clean = company_from_subject(llm) or llm
        if llm_clean and not is_generic_company_name(llm_clean):
            return llm_clean

    for header in (mail_from, parent_sender):
        display = _clean_company_candidate(_parse_mail_display_name(header))
        if display and not is_generic_company_name(display):
            if _COMPANY_LINE_RE.search(display) or _COMPANY_HINT_RE.search(display):
                return display

    from_file = clean_company_from_title(company_name_from_filename(filename))
    if (
        from_file
        and not is_generic_company_name(from_file)
        and (_COMPANY_LINE_RE.search(from_file) or _COMPANY_HINT_RE.search(from_file) or len(from_file.split()) <= 4)
    ):
        return from_file
    return ""


async def pick_owner_company_with_ai(
    raw_text: str,
    *,
    llm_company: str = "",
    mail_from: str = "",
    parent_sender: str = "",
    mail_subject: str = "",
) -> str:
    """Ask Claude to pick the real owner/operator company from candidates + mail context."""
    candidates = _company_candidates_from_text(raw_text)
    for extra in (
        company_from_subject(mail_subject),
        company_from_email_domains(raw_text),
        llm_company if llm_company and not is_generic_company_name(llm_company) else "",
    ):
        if extra and extra not in candidates:
            candidates.insert(0, extra.strip())
    for header in (mail_from, parent_sender):
        display = _parse_mail_display_name(header)
        if display and not is_generic_company_name(display):
            if display not in candidates:
                candidates.append(display)

    lines = [ln.strip() for ln in (raw_text or "").splitlines() if ln.strip()]
    excerpt_parts = lines[:18] + (["…"] if len(lines) > 40 else []) + lines[-22:]
    excerpt = "\n".join(excerpt_parts)[:4500]
    cand_block = "\n".join(f"- {c}" for c in candidates[:12]) or "(none extracted)"
    subject_line = (mail_subject or "").strip() or "(none)"

    prompt = (
        "You pick the OWNER / OPERATOR company for a shipbroking position-list email.\n"
        "Return ONLY the company name as plain text (no quotes, no JSON).\n"
        "Rules:\n"
        "- Prefer real company legal names (…Maritime, …Shipping, LLC, S.A., Pte Ltd, Corp).\n"
        "- Brand names from the subject are valid (e.g. subject 'Shell Eastern Chemical…'\n"
        "  → return 'Shell' or 'Shell Eastern Chemical').\n"
        "- Corporate email domains in the body are strong evidence (@shell.com → Shell).\n"
        "- NEVER return a person name (e.g. Rohan Kalantre).\n"
        "- NEVER return a department/desk (Chartering Dept, Commercial Team, Ops).\n"
        "- NEVER return a raw subject line with dates/Positions wording — clean it to the brand.\n"
        "- NEVER return cargo grades or vessel-class labels (e.g. 'NAP/VEG/CHEMS', 'Large Tanker',\n"
        "  'TYPE: GAS CARRIER', 'MR', 'CPP/CHEMS').\n"
        "- Prefer signature / letterhead company over a desk line above the signature.\n"
        "- If nothing is a real company, return an empty string.\n\n"
        f"SUBJECT:\n{subject_line}\n\n"
        f"CANDIDATES:\n{cand_block}\n\n"
        f"EMAIL EXCERPT (letterhead + signature):\n{excerpt}\n"
    )
    try:
        from config import settings
        from llm import claude_client

        resp = await claude_client.chat.completions.create(
            model=settings.CLAUDE_MODEL,
            messages=[
                {"role": "system", "content": "Return only a company name or empty."},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
            max_tokens=80,
        )
        picked = (resp.choices[0].message.content or "").strip().strip('"').strip("'")
        picked = re.sub(r"^(company\s*[:=]\s*)", "", picked, flags=re.I).strip()
        picked = _clean_company_candidate(picked)
        if picked and is_generic_company_name(picked):
            picked = company_from_subject(picked) or clean_company_from_title(picked)
        if picked and not is_generic_company_name(picked):
            return picked
    except Exception as exc:  # noqa: BLE001
        logger.warning("pick_owner_company_with_ai failed: %s", exc)
    return ""


def _has_value(val: Any) -> bool:
    if val is None:
        return False
    s = str(val).strip()
    if not s or s.lower() in EMPTY_VALUES:
        return False
    if all(c in "-–—." for c in s):
        return False
    return True


def _first_hit(dd: dict, keys: list[str]) -> str:
    for k in keys:
        v = dd.get(k)
        if _has_value(v):
            return str(v).strip()
    return ""


def _extract_imo_number(dd: dict) -> str:
    if _has_value(dd.get("imo")) and IMO_NUMBER_RE.match(str(dd["imo"]).strip()):
        return str(dd["imo"]).strip()
    for k in ("imo_number", "imo"):
        v = str(dd.get(k) or "").strip()
        if IMO_NUMBER_RE.match(v):
            return v
    for k in ("imo_number", "imo"):
        v = str(dd.get(k) or "").strip()
        m = IMO_EMBEDDED_RE.search(v)
        if m:
            return m.group(1)
    return _first_hit(dd, ["imo"])


def _looks_like_imo_type(val: Any) -> bool:
    if not _has_value(val):
        return False
    s = str(val).strip()
    if IMO_NUMBER_RE.match(s):
        return False
    norm = re.sub(r"\s+", "", s.lower())
    if re.match(r"^imo[\d/]+", norm):
        return True
    if re.match(r"^\d+(/\d+)?$", norm):
        return True
    if re.match(r"^(i{1,3}|ii|iii|iv)(/(i{1,3}|ii|iii|iv))?$", norm):
        return True
    return False


def _resolve_imo_for_grid(dd: dict) -> str:
    """IMO column: 7-digit number only (never IMO type codes)."""
    return _resolve_imo_number_only(dd)


def _resolve_imo_number_only(dd: dict) -> str:
    num = _extract_imo_number(dd)
    if num and IMO_NUMBER_RE.match(num):
        return num
    # If imo held a type code, do not treat it as a number.
    if _has_value(dd.get("imo")) and _looks_like_imo_type(dd.get("imo")):
        return ""
    if num and not _looks_like_imo_type(num) and re.search(r"\d{7}", num):
        m = IMO_EMBEDDED_RE.search(num)
        return m.group(1) if m else ""
    return ""


def _resolve_imo_type(dd: dict) -> str:
    if _has_value(dd.get("imo_type")) and _looks_like_imo_type(dd.get("imo_type")):
        return str(dd["imo_type"]).strip()
    for k in ("imo_type", "imo", "vessel_type"):
        v = dd.get(k)
        if _looks_like_imo_type(v):
            return str(v).strip()
    return ""


def _resolve_vessel_type(dd: dict) -> str:
    if _has_value(dd.get("vessel_type")):
        vt = str(dd["vessel_type"]).strip()
        if _looks_like_imo_type(vt):
            return ""
        return vt
    primary = _first_hit(dd, ["vessel_type", "type", "tank_type"])
    if primary and not _looks_like_imo_type(primary):
        return primary
    return ""


def _normalize_imo_and_vessel_type(out: dict[str, str]) -> None:
    """Split IMO number vs IMO type; keep type codes out of vessel_type."""
    imo = (out.get("imo") or "").strip()
    imo_type = (out.get("imo_type") or "").strip()
    vt = (out.get("vessel_type") or "").strip()

    if _looks_like_imo_type(imo):
        if not imo_type:
            out["imo_type"] = imo
        out["imo"] = ""
        imo = ""

    if IMO_NUMBER_RE.match(imo):
        out["imo"] = imo
    elif imo:
        m = IMO_EMBEDDED_RE.search(imo)
        out["imo"] = m.group(1) if m else ""
        if not out["imo"] and _looks_like_imo_type(imo) and not out.get("imo_type"):
            out["imo_type"] = imo

    if _looks_like_imo_type(vt):
        if not out.get("imo_type"):
            out["imo_type"] = vt
        out["vessel_type"] = ""
    elif vt and out.get("imo") and vt.lower() == out["imo"].lower():
        out["vessel_type"] = ""
    elif vt and out.get("imo_type") and vt.lower() == out["imo_type"].lower():
        out["vessel_type"] = ""


def _resolve_open_fields(dd: dict) -> tuple[str, str]:
    if _has_value(dd.get("open_location")):
        loc = str(dd["open_location"]).strip()
    else:
        open_used = None
        loc = ""
        for k in ("port_name", "port", "position", "area", "open"):
            v = dd.get(k)
            if _has_value(v):
                loc = str(v).strip()
                if k == "open":
                    open_used = "location"
                break
    if _has_value(dd.get("opening_date")):
        return loc, str(dd["opening_date"]).strip()
    open_used = None
    date = ""
    for k in ("open_date", "when", "dates", "open"):
        if k == "open" and open_used == "location":
            continue
        v = dd.get(k)
        if _has_value(v):
            date = str(v).strip()
            break
    return loc, date


def _resolve_dwt_sdwt(dd: dict) -> str:
    if _has_value(dd.get("dwt_sdwt")):
        return str(dd["dwt_sdwt"]).strip()
    dwt = _first_hit(dd, ["dwt"])
    sdwt = _first_hit(dd, ["sdwt", "deadweight"])
    if dwt and sdwt:
        return f"{dwt} / {sdwt}"
    return dwt or sdwt


def _resolve_cargo_history(dd: dict) -> str:
    if _has_value(dd.get("cargo_history_combo")):
        return str(dd["cargo_history_combo"]).strip()
    parts: list[str] = []
    for k in (
        "cargo_history", "l3c", "last_3_cargoes", "last_3_cargos", "last_3_cgo", "last_cargo_s",
    ):
        v = dd.get(k)
        if _has_value(v):
            parts.append(str(v).strip())
    return " / ".join(parts)


# ── Trading direction ────────────────────────────────────────────────────────
_DIRECTION_CANON = {
    "ANY", "NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND",
    "WCI", "AG", "WCI/AG", "FAR EAST", "SEA", "WORLDWIDE", "WEST INDIA",
}

# Full normaliser for an explicit direction phrase (short, dedicated field).
_DIRECTION_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"wci\s*[/&]\s*ag|ag\s*[/&]\s*wci", re.I), "WCI/AG"),
    (re.compile(r"north\s*bound|northbound|\bn\.?b\.?\b", re.I), "NORTHBOUND"),
    (re.compile(r"south\s*bound|southbound|\bs\.?b\.?\b", re.I), "SOUTHBOUND"),
    (re.compile(r"east\s*bound|eastbound|\be\.?b\.?\b", re.I), "EASTBOUND"),
    (re.compile(r"west\s*bound|westbound|\bw\.?b\.?\b", re.I), "WESTBOUND"),
    (re.compile(r"far\s*east|f\.?\s*east|feast", re.I), "FAR EAST"),
    (re.compile(r"world\s*wide|worldwide|\bw\.?w\.?\b|trading\s+worldwide", re.I), "WORLDWIDE"),
    (re.compile(r"west\s+india", re.I), "WEST INDIA"),
    (re.compile(r"wci|west\s+coast\s+india", re.I), "WCI"),
    (re.compile(r"\bag\b|arabian\s+gulf", re.I), "AG"),
    (re.compile(r"south\s*east\s*asia|\bsea\b", re.I), "SEA"),
    (re.compile(r"any\s*dir\w*|any\s+direction|\bany\b", re.I), "ANY"),
]

# Stricter patterns for scanning INSIDE larger free-text fields (avoid bare
# words like "any"/"ag"/"sea" that appear in unrelated prose).
_DIRECTION_TEXT_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"wci\s*[/&]\s*ag|ag\s*[/&]\s*wci", re.I), "WCI/AG"),
    (re.compile(r"north\s*bound|northbound", re.I), "NORTHBOUND"),
    (re.compile(r"south\s*bound|southbound", re.I), "SOUTHBOUND"),
    (re.compile(r"east\s*bound|eastbound", re.I), "EASTBOUND"),
    (re.compile(r"west\s*bound|westbound", re.I), "WESTBOUND"),
    (re.compile(r"any\s*dir\w*|any\s+direction", re.I), "ANY"),
    (re.compile(r"far\s*east|feast", re.I), "FAR EAST"),
    (re.compile(r"world\s*wide|worldwide|trading\s+worldwide", re.I), "WORLDWIDE"),
    (re.compile(r"\bwci\b|west\s+coast\s+india", re.I), "WCI"),
]


def _normalize_direction(text: str) -> str:
    """Map a short direction phrase to a canonical token; '' if unrecognized."""
    if not text:
        return ""
    up = re.sub(r"\s+", " ", str(text).strip().upper())
    if up in _DIRECTION_CANON:
        return up
    for pat, canon in _DIRECTION_PATTERNS:
        if pat.search(str(text)):
            return canon
    return ""


def _derive_direction_from_text(text: str) -> str:
    for pat, canon in _DIRECTION_TEXT_PATTERNS:
        if pat.search(text):
            return canon
    return ""


def _resolve_direction(dd: dict) -> str:
    """Direction from an explicit key, else derived from free-text fields."""
    explicit = _first_hit(dd, ["direction", "dir"])
    if explicit:
        return _normalize_direction(explicit) or explicit.strip().upper()
    for k in ("cargo_type", "remarks", "other_info", "cargo_history_combo", "status"):
        v = dd.get(k)
        if _has_value(v):
            derived = _derive_direction_from_text(str(v))
            if derived:
                return derived
    return ""


def empty_standard_dynamic_data() -> dict[str, str]:
    return {k: "" for k in STANDARD_DYNAMIC_KEYS}


def needs_migration(dd: dict | None) -> bool:
    """True when dynamic_data is not exactly the standard keys."""
    if not dd:
        return False
    return set(dd.keys()) != set(STANDARD_DYNAMIC_KEYS)


def _expand_two_digit_year(yy: int) -> int:
    return 2000 + yy if yy <= 49 else 1900 + yy


def _normalize_year_int(raw) -> int | None:
    digits = re.sub(r"[^\d]", "", str(raw or ""))
    if not digits:
        return None
    try:
        n = int(digits)
    except ValueError:
        return None
    if 1000 <= n <= 2100:
        return n
    if 0 <= n <= 99:
        return _expand_two_digit_year(n)
    return None


_MONTHS = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)
_MONTH_INDEX = {}
for _i, _name in enumerate(_MONTHS):
    _MONTH_INDEX[_name.lower()] = _i
    _MONTH_INDEX[_name[:3].lower()] = _i
_MONTH_INDEX["sept"] = 8

_SMALL_WORDS = frozenset({"of", "the", "a", "an", "and", "to", "for", "in", "on", "at"})
_ORDINAL_WORDS = frozenset({"st", "nd", "rd", "th"})


def _normalize_date_ordinals(raw: str) -> str:
    """Lowercase ordinals and glue '23 Rd' → '23rd'."""
    s = str(raw or "").strip()
    if not s:
        return ""
    s = re.sub(r"\b(st|nd|rd|th)\b", lambda m: m.group(0).lower(), s, flags=re.I)
    s = re.sub(r"(\d)\s+(st|nd|rd|th)\b", r"\1\2", s, flags=re.I)
    return s


def _day_with_ordinal(n) -> str:
    try:
        d = int(n)
    except (TypeError, ValueError):
        return str(n)
    mod100 = d % 100
    mod10 = d % 10
    suf = "th"
    if mod100 < 11 or mod100 > 13:
        if mod10 == 1:
            suf = "st"
        elif mod10 == 2:
            suf = "nd"
        elif mod10 == 3:
            suf = "rd"
    return f"{d}{suf}"


def _format_open_position_text(raw: str) -> str:
    parts: list[str] = []
    for i, word in enumerate(re.split(r"\s+", _normalize_date_ordinals(raw).lower())):
        if not word:
            continue
        bare = re.sub(r"[^a-z]", "", word)
        if bare in _MONTH_INDEX:
            month = _MONTHS[_MONTH_INDEX[bare]]
            parts.append(re.sub(bare, month, word, count=1, flags=re.I))
        elif bare in _ORDINAL_WORDS:
            parts.append(word.lower())
        elif i > 0 and bare in _SMALL_WORDS:
            parts.append(word.lower())
        else:
            # Don't title-case the leading letter of an ordinal glued to a day (23rd).
            fixed = re.sub(
                r"(^|[^0-9a-z])([a-z])",
                lambda m: m.group(1) + m.group(2).upper(),
                word,
            )
            fixed = re.sub(
                r"(\d)(st|nd|rd|th)\b",
                lambda m: m.group(1) + m.group(2).lower(),
                fixed,
                flags=re.I,
            )
            parts.append(fixed)
    return " ".join(parts)


def _format_day_month_year(day, month_idx, year) -> str | None:
    try:
        d = int(day)
    except (TypeError, ValueError):
        return None
    y = _normalize_year_int(year)
    if y is None:
        from datetime import datetime
        y = datetime.now().year
    if not (1 <= d <= 31) or month_idx is None or not (0 <= month_idx <= 11):
        return None
    return f"{d} {_MONTHS[month_idx]} {y}"


def _parse_one_opening_date(fragment: str) -> str | None:
    s = re.sub(r"\s+", " ", fragment.strip().replace(",", " "))
    if not s:
        return None

    m = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$", s)
    if m:
        return _format_day_month_year(m.group(1), int(m.group(2)) - 1, m.group(3))

    m = re.match(r"^(\d{1,2})[-\s]+([A-Za-z]+)(?:[-\s]+(\d{2,4}))?$", s)
    if m and m.group(2).lower() in _MONTH_INDEX:
        from datetime import datetime
        return _format_day_month_year(
            m.group(1),
            _MONTH_INDEX[m.group(2).lower()],
            m.group(3) or str(datetime.now().year),
        )

    m = re.match(r"^([A-Za-z]+)[-\s]+(\d{1,2})(?:[-\s]+(\d{2,4}))?$", s)
    if m and m.group(1).lower() in _MONTH_INDEX:
        from datetime import datetime
        return _format_day_month_year(
            m.group(2),
            _MONTH_INDEX[m.group(1).lower()],
            m.group(3) or str(datetime.now().year),
        )

    m = re.match(r"^(\d{1,2})\s+([A-Za-z]+)\s+(\d{2,4})$", s)
    if m and m.group(2).lower() in _MONTH_INDEX:
        return _format_day_month_year(m.group(1), _MONTH_INDEX[m.group(2).lower()], m.group(3))

    return None


def _format_opening_date(raw: str) -> str:
    s = _normalize_date_ordinals(raw)
    if not s:
        return ""

    m = re.match(
        r"^(\d{1,2})(?:st|nd|rd|th)?\s*[-/–—]\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:\s+(\d{2,4}))?$",
        s,
        flags=re.I,
    )
    if m and m.group(3).lower() in _MONTH_INDEX:
        from datetime import datetime
        y = _normalize_year_int(m.group(4) or str(datetime.now().year))
        end = _day_with_ordinal(m.group(2)) if re.search(r"(?:st|nd|rd|th)", s, re.I) else str(int(m.group(2)))
        return f"{int(m.group(1))}-{end} {_MONTHS[_MONTH_INDEX[m.group(3).lower()]]} {y}"

    m = re.match(
        r"^(\d{1,2})(?:st|nd|rd|th)?\s*[-/]\s*(\d{1,2})(?:st|nd|rd|th)?[/.-](\d{1,2})[/.-](\d{2,4})$",
        s,
        flags=re.I,
    )
    if m:
        month = int(m.group(3)) - 1
        y = _normalize_year_int(m.group(4))
        if 0 <= month <= 11 and y:
            end = _day_with_ordinal(m.group(2)) if re.search(r"(?:st|nd|rd|th)", s, re.I) else str(int(m.group(2)))
            return f"{int(m.group(1))}-{end} {_MONTHS[month]} {y}"

    m = re.match(
        r"^(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)(?:\s+(\d{2,4}))?$",
        s,
        flags=re.I,
    )
    if m and m.group(2).lower() in _MONTH_INDEX:
        from datetime import datetime
        y = _normalize_year_int(m.group(3) or str(datetime.now().year))
        return f"{_day_with_ordinal(m.group(1))} {_MONTHS[_MONTH_INDEX[m.group(2).lower()]]} {y}"

    one = _parse_one_opening_date(re.sub(r"(\d{1,2})(?:st|nd|rd|th)\b", r"\1", s, flags=re.I))
    if one:
        return one
    return _format_open_position_text(s)


def _format_rounded_figures(raw: str) -> str:
    s = str(raw or "").strip()
    if not s:
        return ""

    def _repl(match: re.Match) -> str:
        token = match.group(0)
        try:
            n = float(token.replace(",", ""))
        except ValueError:
            return token
        return f"{int(round(n)):,}"

    return re.sub(r"[\d,]+(?:\.\d+)?", _repl, s)


_K_SUFFIX_RE = re.compile(
    r"(?P<num>[\d,]+(?:\.\d+)?)\s*[kK]\b",
)


def _expand_k_suffixes(raw: str) -> tuple[str, bool]:
    """Expand 160k / 107.5k → full tonnes. Returns (text, had_k)."""
    s = str(raw or "").strip()
    if not s:
        return "", False
    had_k = False

    def _repl(m: re.Match) -> str:
        nonlocal had_k
        had_k = True
        try:
            n = float(m.group("num").replace(",", ""))
        except ValueError:
            return m.group(0)
        return str(int(round(n * 1000)))

    return _K_SUFFIX_RE.sub(_repl, s), had_k


def _format_dwt_sdwt(raw: str) -> tuple[str, bool, bool]:
    """Round DWT/SDWT; bare values under 1000 are ×1000 shorthand (49 → 49,000).

    Values already written with a ``k`` suffix (160k) are expanded but NOT marked
    as AI-normalized (they were already in thousands).
    Returns (formatted, scaled, had_k).
    """
    s = str(raw or "").strip()
    if not s:
        return "", False, False

    s, had_k = _expand_k_suffixes(s)
    scaled = False

    def _repl(match: re.Match) -> str:
        nonlocal scaled
        token = match.group(0)
        try:
            n = float(token.replace(",", ""))
        except ValueError:
            return token
        if 0 < n < 1000:
            n *= 1000
            scaled = True
        return f"{int(round(n)):,}"

    formatted = re.sub(r"[\d,]+(?:\.\d+)?", _repl, s)
    return formatted, scaled, had_k


def _format_cbm(raw: str) -> tuple[str, bool, bool]:
    """CBM/cubic: same ×1000 shorthand as DWT; whole numbers; k-suffix not highlighted."""
    s = str(raw or "").strip()
    if not s:
        return "", False, False

    s, had_k = _expand_k_suffixes(s)
    scaled = False

    def _repl(match: re.Match) -> str:
        nonlocal scaled
        token = match.group(0)
        try:
            n = float(token.replace(",", ""))
        except ValueError:
            return token
        if 0 < n < 1000:
            n *= 1000
            scaled = True
        return f"{int(round(n)):,}"

    formatted = re.sub(r"[\d,]+(?:\.\d+)?", _repl, s)
    return formatted, scaled, had_k


def _parse_ai_normalized(raw) -> set[str]:
    s = str(raw or "").strip()
    if not s:
        return set()
    return {p.strip() for p in s.split(",") if p.strip()}


def _format_ai_normalized(flags: set[str]) -> str:
    return ",".join(sorted(flags))


def _format_year_built(raw: str) -> tuple[str, bool]:
    """Normalize year built. Returns (formatted, expanded) when 2-digit → 4-digit."""
    s = str(raw or "").strip()
    if not s:
        return "", False
    m4 = re.search(r"\b(\d{4})\b", s)
    if m4:
        y = _normalize_year_int(m4.group(1))
        return (str(y) if y is not None else s), False
    m2 = re.search(r"\b(\d{1,2})\b", s)
    if not m2:
        return s, False
    y = _normalize_year_int(m2.group(1))
    if y is None:
        return s, False
    return str(y), True


def _normalize_standard_formats(out: dict[str, str]) -> None:
    flags = _parse_ai_normalized(out.get("ai_normalized"))
    if _has_value(out.get("opening_date")):
        out["opening_date"] = _format_opening_date(out["opening_date"])
    if _has_value(out.get("open_location")):
        out["open_location"] = strip_parenthetical_extras(out["open_location"])
    if _has_value(out.get("dwt_sdwt")):
        formatted, scaled, had_k = _format_dwt_sdwt(out["dwt_sdwt"])
        out["dwt_sdwt"] = formatted
        if scaled:
            flags.add("dwt_sdwt")
        elif had_k:
            # Explicit k-form was already in thousands — never highlight.
            flags.discard("dwt_sdwt")
        # else: keep any existing flag (e.g. LLM expanded 49→49,000 before our scaler)
    if _has_value(out.get("cbm")):
        formatted, scaled, had_k = _format_cbm(out["cbm"])
        out["cbm"] = formatted
        if scaled:
            flags.add("cbm")
        elif had_k:
            flags.discard("cbm")
    if _has_value(out.get("year_built")):
        formatted, expanded = _format_year_built(out["year_built"])
        out["year_built"] = formatted
        if expanded:
            flags.add("year_built")
        # else: keep existing flag (LLM already expanded 17→2017)
    out["ai_normalized"] = _format_ai_normalized(flags)


def mark_bare_dwt_ai_flag(dd: dict, raw_text: str) -> None:
    """Set dwt_sdwt AI-normalized when mail shows bare shorthand but value is already ×1000.

    Covers LLM expanding ``49`` → ``49,000`` before our scaler runs (no blue outline otherwise).
    Does not change the stored value — only the highlight flag.
    """
    flags = _parse_ai_normalized(dd.get("ai_normalized"))
    if "dwt_sdwt" in flags:
        return
    dwt = str(dd.get("dwt_sdwt") or "")
    m = re.search(r"[\d,]+(?:\.\d+)?", dwt)
    if not m:
        return
    try:
        full = float(m.group(0).replace(",", ""))
    except ValueError:
        return
    if full < 1000 or abs(full % 1000) > 0.01:
        return
    bare = int(round(full / 1000))
    if bare < 1 or bare >= 1000:
        return
    name = str(dd.get("vessel_name") or "").strip()
    text = raw_text or ""
    if not name or not text:
        return
    name_pat = re.sub(r"\\\s+", r"\\s+", re.escape(name))
    full_int = int(round(full))
    for match in re.finditer(name_pat, text, flags=re.I):
        window = text[match.start() : match.start() + 180]
        window_digits = window.replace(",", "")
        if re.search(rf"(?<!\d){full_int}(?!\d)", window_digits):
            continue
        if re.search(rf"(?<![\d.]){bare}(?![\d.])", window):
            flags.add("dwt_sdwt")
            dd["ai_normalized"] = _format_ai_normalized(flags)
            return


def mark_bare_year_ai_flag(dd: dict, raw_text: str) -> None:
    """Set year_built AI-normalized when mail shows 2-digit year but value is already 4-digit."""
    flags = _parse_ai_normalized(dd.get("ai_normalized"))
    if "year_built" in flags:
        return
    year_s = str(dd.get("year_built") or "").strip()
    m = re.search(r"\b((?:19|20)\d{2})\b", year_s)
    if not m:
        return
    full = int(m.group(1))
    bare = full % 100
    bare_str = f"{bare:02d}" if bare < 10 else str(bare)
    # Also accept unpadded single digit for years like 2005 → "5" (rare in lists).
    bare_alts = {str(bare), bare_str}
    name = str(dd.get("vessel_name") or "").strip()
    text = raw_text or ""
    if not name or not text:
        return
    name_pat = re.sub(r"\\\s+", r"\\s+", re.escape(name))
    for match in re.finditer(name_pat, text, flags=re.I):
        window = text[match.start() : match.start() + 180]
        if re.search(rf"(?<!\d){full}(?!\d)", window):
            continue
        for b in bare_alts:
            if re.search(rf"(?<!\d){re.escape(b)}(?!\d)", window):
                flags.add("year_built")
                dd["ai_normalized"] = _format_ai_normalized(flags)
                return


def _broker_region_for_audit(src: dict, region: str | None, existing_raw: str = "") -> str:
    """Prefer real broker wording; ignore values that are only standard region codes."""
    from region_map import is_standard_region

    def _usable(text: str) -> str:
        t = str(text or "").strip()
        if not t:
            return ""
        # Keep non-standard broker strings (e.g. "SEA / ECI"). Standard codes alone
        # are usually prior derived values, not useful audit text.
        if is_standard_region(t):
            return ""
        return t

    existing = _usable(existing_raw or src.get("region_raw") or "")
    if existing:
        return existing
    passed = _usable(region)
    if passed:
        return passed
    return _usable(_first_hit(src, ["region"]))


def map_raw_to_standard(dd: dict | None, region: str | None = None) -> tuple[dict[str, str], str]:
    """Map legacy or partial LLM output into the standard dynamic_data keys.

    Working ``region`` is always derived from ``open_location`` (see region_map).
    Broker email region text is preserved in ``dynamic_data.region_raw``.
    """
    src = dd or {}

    if not needs_migration(src):
        out = {k: str(src.get(k, "") or "").strip() for k in STANDARD_DYNAMIC_KEYS}
        _normalize_imo_and_vessel_type(out)
        _normalize_standard_formats(out)
        from region_map import derive_vessel_region
        broker_region = _broker_region_for_audit(src, region, out.get("region_raw") or "")
        derived, region_raw = derive_vessel_region(out.get("open_location"), broker_region)
        out["region_raw"] = region_raw
        return out, derived

    loc, date = _resolve_open_fields(src)
    loc = strip_parenthetical_extras(loc)
    out: dict[str, str] = {
        "company": _first_hit(src, ["company"]),
        "imo": _resolve_imo_number_only(src),
        "imo_type": _resolve_imo_type(src),
        "vessel_name": _first_hit(src, ["vessel_name", "name"]),
        "call_sign": _first_hit(src, ["call_sign"]),
        "year_built": _first_hit(src, ["year_built", "built", "yard_built", "year", "when"]),
        "vessel_type": _resolve_vessel_type(src),
        "cargo_type": _first_hit(src, ["cargo_type", "grade", "last_cargo", "cargo_preference"]),
        "direction": _resolve_direction(src),
        "dwt_sdwt": _resolve_dwt_sdwt(src),
        "cbm": _first_hit(src, ["cbm", "cubic", "cub", "cargo_tank_capacity", "m3", "capacity"]),
        "draft": _first_hit(src, ["draft", "sdraft", "sdwt_draft"]),
        "flag": _first_hit(src, ["flag"]),
        "eta_foc": _first_hit(src, ["eta_foc", "eta foc"]),
        "open_location": loc,
        "opening_date": date,
        "cargo_history_combo": _resolve_cargo_history(src),
        "tank_coating": _first_hit(src, ["tank_coating", "coating", "coat", "tanks", "tank_type"]),
        "sire_date": _first_hit(src, ["sire_date", "sire"]),
        "sire_location": _first_hit(src, ["sire_location"]),
        "cdi_date": _first_hit(src, ["cdi_date", "cdi"]),
        "cdi_location": _first_hit(src, ["cdi_location"]),
        "remarks": _first_hit(src, ["remarks", "remark", "comments", "comment"]),
        "other_info": _first_hit(src, ["other_info", "extra_info"]),
        "q88": _first_hit(src, ["q88"]),
        "status": _first_hit(src, ["status", "open_status"]),
        "ai_normalized": str(src.get("ai_normalized") or "").strip(),
        "region_raw": str(src.get("region_raw") or "").strip(),
    }

    # Leftover source keys that are not mapped → Extra Info.
    known = set(STANDARD_DYNAMIC_KEYS) | {
        "dwt", "sdwt", "deadweight", "built", "yard_built", "year", "when", "coating", "coat",
        "last_cargo", "cargo_preference", "grade", "last_3_cargoes", "last_3_cargos",
        "last_3_cgo", "last_cargo_s", "l3c", "cargo_history", "open_date", "dates",
        "port_name", "port", "position", "area", "open", "name", "type", "tank_type",
        "cubic", "cub", "cargo_tank_capacity", "m3", "capacity", "remark", "comments",
        "comment", "sire", "cdi", "open_status", "imo_number", "sdraft", "sdwt_draft",
        "region", "Company", "extra_info", "pic", "contact",
    }
    leftovers: list[str] = []
    for k, v in src.items():
        key = str(k or "").strip().lower().replace(" ", "_")
        if key in known or key.startswith("_"):
            continue
        if not _has_value(v):
            continue
        leftovers.append(f"{k}: {str(v).strip()}")
    if leftovers:
        extra = out.get("other_info") or ""
        joined = "; ".join(leftovers)
        out["other_info"] = f"{extra}; {joined}".strip("; ").strip() if extra else joined

    from region_map import derive_vessel_region
    broker_region = _broker_region_for_audit(src, region, out.get("region_raw") or "")
    derived, region_raw = derive_vessel_region(out.get("open_location"), broker_region)
    out["region_raw"] = region_raw
    _normalize_imo_and_vessel_type(out)
    _normalize_standard_formats(out)
    return out, derived


def ensure_column_definitions(supabase) -> None:
    """Seed column_definitions when empty (first install)."""
    existing = supabase.table("column_definitions").select("id").limit(1).execute()
    if existing.data:
        return
    for col in DEFAULT_COLUMN_DEFINITIONS:
        supabase.table("column_definitions").insert(dict(col)).execute()
    logger.info("Seeded %d column_definitions rows", len(DEFAULT_COLUMN_DEFINITIONS))


def sync_column_definitions(supabase) -> None:
    """Insert missing columns and refresh display_order from DEFAULT_COLUMN_DEFINITIONS."""
    rows = supabase.table("column_definitions").select("id").execute()
    existing_ids = {r["id"] for r in (rows.data or [])}
    if not existing_ids:
        ensure_column_definitions(supabase)
        return
    for col in DEFAULT_COLUMN_DEFINITIONS:
        payload = dict(col)
        if payload["id"] in existing_ids:
            supabase.table("column_definitions").update({
                "header": payload["header"],
                "display_order": payload["display_order"],
                "read_only": payload["read_only"],
                "storage": payload["storage"],
            }).eq("id", payload["id"]).execute()
        else:
            supabase.table("column_definitions").insert(payload).execute()
    logger.info("Synced %d column_definitions rows", len(DEFAULT_COLUMN_DEFINITIONS))


def fix_imo_vessel_type_misplacement(supabase) -> int:
    """Re-map rows where IMO type was stored in vessel_type (safe to run every startup)."""
    rows = supabase.table("vessels").select("id, dynamic_data, region").execute()
    updated = 0
    for vessel in rows.data or []:
        dd = vessel.get("dynamic_data") or {}
        standardized, reg = map_raw_to_standard(dd, vessel.get("region"))
        old_vt = str(dd.get("vessel_type") or "").strip()
        new_vt = str(standardized.get("vessel_type") or "").strip()
        old_imo = str(dd.get("imo") or "").strip()
        new_imo = str(standardized.get("imo") or "").strip()
        if old_vt == new_vt and old_imo == new_imo and standardized == dd:
            continue
        supabase.table("vessels").update({
            "dynamic_data": standardized,
            "region": reg,
        }).eq("id", vessel["id"]).execute()
        updated += 1
    if updated:
        logger.info("Fixed IMO/vessel_type placement on %d vessel rows", updated)
    return updated


def migrate_all_vessel_rows(supabase) -> int:
    """Normalize every vessel row to the standard schema + display formats.

    Also re-derives ``region`` from ``open_location`` (idempotent) and stores
    broker wording in ``dynamic_data.region_raw``.
    """
    rows = supabase.table("vessels").select("id, dynamic_data, region").execute()
    updated = 0
    for vessel in rows.data or []:
        dd = vessel.get("dynamic_data") or {}
        standardized, reg = map_raw_to_standard(dd, vessel.get("region"))
        payload: dict[str, Any] = {"dynamic_data": standardized, "region": reg}
        if standardized == dd and reg == (vessel.get("region") or ""):
            continue
        supabase.table("vessels").update(payload).eq("id", vessel["id"]).execute()
        updated += 1
    if updated:
        logger.info("Migrated %d vessel rows to standard column schema", updated)
    return updated


def normalize_vessel_field_formats(supabase) -> int:
    """Alias for migrate — reformats opening_date, DWT/CBM, year_built in place."""
    return migrate_all_vessel_rows(supabase)


def backfill_vessel_company_names(supabase) -> int:
    """Set dynamic_data.company using filename, signature, contacts, and vessel-name hints."""
    vessels = supabase.table("vessels").select("id, attachment_id, dynamic_data").execute()
    vessel_rows = vessels.data or []
    if not vessel_rows:
        return 0

    att_ids = list({v["attachment_id"] for v in vessel_rows if v.get("attachment_id")})
    if not att_ids:
        return 0

    att_rows = (
        supabase.table("attachments")
        .select("id, filename, mail_from, mail_subject, raw_text, parent_email_id")
        .in_("id", att_ids)
        .execute()
    ).data or []
    att_by_id = {a["id"]: a for a in att_rows}

    parent_ids = list({a.get("parent_email_id") for a in att_rows if a.get("parent_email_id")})
    parent_sender: dict[str, str] = {}
    if parent_ids:
        parents = (
            supabase.table("parent_emails")
            .select("id, sender")
            .in_("id", parent_ids)
            .execute()
        ).data or []
        parent_sender = {p["id"]: p.get("sender") or "" for p in parents}

    contacts_by_att: dict[str, list[str]] = {aid: [] for aid in att_ids}
    contact_rows = (
        supabase.table("broker_contacts")
        .select("attachment_id, company")
        .in_("attachment_id", att_ids)
        .execute()
    ).data or []
    for row in contact_rows:
        aid = row.get("attachment_id")
        company = (row.get("company") or "").strip()
        if aid and company and company not in contacts_by_att.get(aid, []):
            contacts_by_att.setdefault(aid, []).append(company)

    updated = 0
    for vessel in vessel_rows:
        att_id = vessel.get("attachment_id")
        att = att_by_id.get(att_id, {})
        dd = dict(vessel.get("dynamic_data") or {})
        vessel_name = dd.get("vessel_name") or ""
        current = (dd.get("company") or "").strip()
        company = resolve_vessel_company(
            att.get("filename") or "",
            mail_from=att.get("mail_from") or "",
            parent_sender=parent_sender.get(att.get("parent_email_id") or "", ""),
            raw_text=att.get("raw_text") or "",
            mail_subject=att.get("mail_subject") or "",
            vessel_name=vessel_name,
            llm_company=current if not is_generic_company_name(current) else "",
            broker_companies=contacts_by_att.get(att_id, []),
        )
        # Clear leftover cargo/type mis-maps even when no better company is found.
        if not company:
            if current and is_generic_company_name(current):
                dd["company"] = ""
                supabase.table("vessels").update({"dynamic_data": dd}).eq("id", vessel["id"]).execute()
                updated += 1
            continue
        if current == company:
            continue
        dd["company"] = company
        supabase.table("vessels").update({"dynamic_data": dd}).eq("id", vessel["id"]).execute()
        updated += 1

    if updated:
        logger.info("Backfilled company on %d vessel rows", updated)
    return updated


def get_column_definitions(supabase) -> list[dict[str, Any]]:
    rows = (
        supabase.table("column_definitions")
        .select("id, header, display_order, read_only, storage")
        .order("display_order")
        .execute()
    )
    return rows.data or DEFAULT_COLUMN_DEFINITIONS.copy()


def get_column_ids(supabase) -> list[str]:
    return [c["id"] for c in get_column_definitions(supabase)]


def format_attachment_files(files: Any) -> str:
    """Comma-separated names of real file attachments (PDF/image/xlsx…) on the email."""
    if not files:
        return ""
    if isinstance(files, str):
        try:
            files = json.loads(files)
        except json.JSONDecodeError:
            return ""
    if not isinstance(files, list):
        return ""
    names: list[str] = []
    for entry in files:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if name:
            names.append(name)
    return ", ".join(names)


def resolve_cell_value(vessel: dict, column_id: str, row_num: int = 1) -> str:
    if column_id == "_num":
        return str(row_num)
    if column_id == "region":
        return str(vessel.get("region") or "").strip()
    if column_id == "attachments":
        return format_attachment_files(vessel.get("attachment_files"))
    if column_id == "vessel_type":
        dd = vessel.get("dynamic_data") or {}
        vt = str(dd.get("vessel_type") or "").strip()
        imo = str(dd.get("imo") or "").strip()
        if _looks_like_imo_type(vt) or (vt and imo and vt.lower() == imo.lower()):
            return ""
        return vt
    if column_id == "imo":
        dd = vessel.get("dynamic_data") or {}
        imo = str(dd.get("imo") or "").strip()
        if imo:
            return imo
        vt = dd.get("vessel_type")
        if _looks_like_imo_type(vt):
            return str(vt).strip()
        return ""
    dd = vessel.get("dynamic_data") or {}
    return str(dd.get(column_id) or "").strip()


def header_for_column(column_id: str, columns: list[dict] | None = None) -> str:
    cols = columns or DEFAULT_COLUMN_DEFINITIONS
    for c in cols:
        if c["id"] == column_id:
            return c["header"]
    return column_id.replace("_", " ").upper()
