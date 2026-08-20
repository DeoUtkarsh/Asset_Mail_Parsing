"""
Owners directory CSV upload.

Any CSV header layout is accepted. A small library maps obvious headers, then
an AI agent reviews headers + sample rows and places leftover columns into
broker_contacts fields. Rows are stored as source=owners-list only.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import re
from typing import Any

from agents.contact_extract import (
    CONTACT_FIELD_KEYS,
    _clean_contact_val,
    _parse_contact_json,
)
from config import settings
from llm import claude_client, files_to_content_blocks
from owners_import import (
    _emails,
    _person_row,
    _remarks_fields,
    import_owner_contacts,
    parse_owners_xls_bytes,
    parse_owners_xlsx_bytes,
)

import pipeline_log as plog

logger = logging.getLogger(__name__)

CSV_MAP_PROMPT = """\
You map a contact CSV onto the Owners directory fields used in Shipbroker Sense.

TARGET FIELDS (use these exact keys, or null to ignore a column):
contact_name — person / PIC name
company — company / desk name (NOT trade)
company_type — only if the header is clearly company type
designation — job title
department — chartering / ops desk
vessel_name — ship names only
email — any email (PIC or office; they will be merged)
off_phone — office / telephone / DID
mob_phone — PIC mobile / cell
wechat, whatsapp, website_address, fax
office_address — full street / building address
other_info — remarks / notes. NEVER ship names
status — Active / Inactive
country, city
trade — cargo / fleet focus (CPP, Chemical, MR, small tankers). NOT company name
role — Owner / Broker / Operator / Charterer

Rules:
- One CSV column maps to at most one field.
- Several CSV columns MAY map to the same field (emails, phones) — they are merged.
- If a remarks column is clearly a vessel list, map it to vessel_name.
- Ignore serial numbers, IDs, empty columns.
- Do not invent mappings.

CSV HEADERS:
{headers_json}

SAMPLE ROWS (up to 8):
{samples_json}

Return ONLY JSON:
{{"mapping": {{"<csv header>": "<field or null>"}}}}
"""

_HEADER_ALIASES: dict[str, str] = {
    "pic name": "contact_name",
    "pic": "contact_name",
    "name": "contact_name",
    "contact name": "contact_name",
    "contact": "contact_name",
    "person": "contact_name",
    "full address": "office_address",
    "address": "office_address",
    "office address": "office_address",
    "country": "country",
    "city": "city",
    "telephone": "off_phone",
    "tel": "off_phone",
    "office tel": "off_phone",
    "office phone": "off_phone",
    "phone": "off_phone",
    "pic mobile": "mob_phone",
    "mobile": "mob_phone",
    "cell": "mob_phone",
    "handphone": "mob_phone",
    "email": "email",
    "e-mail": "email",
    "pic email": "email",
    "office email": "email",
    "website": "website_address",
    "web": "website_address",
    "url": "website_address",
    "owners / operators": "trade",
    "owners/operators": "trade",
    "trade": "trade",
    "cargo": "trade",
    "fleet": "trade",
    "remarks": "other_info",
    "other info": "other_info",
    "notes": "other_info",
    "vessel name": "vessel_name",
    "vessels": "vessel_name",
    "vessel": "vessel_name",
    "company name": "company",
    "company": "company",
    "designation": "designation",
    "title": "designation",
    "department": "department",
    "dept": "department",
    "company type": "company_type",
    "role": "role",
    "status": "status",
    "wechat": "wechat",
    "whatsapp": "whatsapp",
    "fax": "fax",
}


def _norm_header(raw: str) -> str:
    s = str(raw or "").strip().lower()
    s = s.replace("_", " ").replace("-", " ")
    s = re.sub(r"\s+", " ", s)
    return s.strip(" .:")


def _detect_delimiter(sample: str) -> str:
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        return dialect.delimiter
    except csv.Error:
        if sample.count(";") > sample.count(","):
            return ";"
        if sample.count("\t") > sample.count(","):
            return "\t"
        return ","


def parse_csv_table(raw: bytes) -> tuple[list[str], list[dict[str, str]]]:
    text = raw.decode("utf-8-sig", errors="replace")
    if not text.strip():
        return [], []
    delim = _detect_delimiter(text[:4000])
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    headers = [str(h).strip() for h in (reader.fieldnames or []) if str(h).strip()]
    rows: list[dict[str, str]] = []
    for rec in reader:
        if not isinstance(rec, dict):
            continue
        cleaned = {
            str(k).strip(): "" if v is None else str(v).strip()
            for k, v in rec.items()
            if k is not None and str(k).strip()
        }
        if any(cleaned.values()):
            rows.append(cleaned)
    return headers, rows


def heuristic_mapping(headers: list[str]) -> dict[str, str | None]:
    mapping: dict[str, str | None] = {}
    for h in headers:
        key = _HEADER_ALIASES.get(_norm_header(h))
        mapping[h] = key
    return mapping


def _parse_mapping_json(text: str) -> dict[str, str | None]:
    text = re.sub(r"```(?:json)?\s*", "", text)
    text = re.sub(r"```\s*$", "", text, flags=re.MULTILINE).strip()
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return {}
        try:
            obj = json.loads(m.group())
        except json.JSONDecodeError:
            return {}
    raw = obj.get("mapping") if isinstance(obj, dict) else None
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str | None] = {}
    for k, v in raw.items():
        header = str(k).strip()
        if not header:
            continue
        if v is None or str(v).strip().lower() in ("", "null", "none", "ignore"):
            out[header] = None
            continue
        field = str(v).strip()
        out[header] = field if field in CONTACT_FIELD_KEYS else None
    return out


async def ai_map_headers(
    headers: list[str],
    sample_rows: list[dict[str, str]],
) -> dict[str, str | None]:
    samples = sample_rows[:8]
    resp = await claude_client.chat.completions.create(
        model=settings.CLAUDE_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You map CSV columns onto a shipbroker owners-directory schema. "
                    "Output only valid JSON."
                ),
            },
            {
                "role": "user",
                "content": CSV_MAP_PROMPT.format(
                    headers_json=json.dumps(headers, ensure_ascii=False),
                    samples_json=json.dumps(samples, ensure_ascii=False),
                ),
            },
        ],
        temperature=0.0,
        max_tokens=1200,
    )
    content = resp.choices[0].message.content or ""
    return _parse_mapping_json(content)


def _merge_mapping(
    headers: list[str],
    heuristic: dict[str, str | None],
    ai: dict[str, str | None],
) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for h in headers:
        ai_field = ai.get(h)
        if ai_field:
            out[h] = ai_field
        else:
            out[h] = heuristic.get(h)
    return out


def _join_parts(parts: list[str], sep: str = ", ") -> str:
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        s = _clean_contact_val(p)
        if not s:
            continue
        key = s.lower()
        if key not in seen:
            seen.add(key)
            out.append(s)
    return sep.join(out)


def rows_from_csv(
    csv_rows: list[dict[str, str]],
    mapping: dict[str, str | None],
) -> list[dict[str, str]]:
    last_company = ""
    parsed: list[dict[str, str]] = []
    for rec in csv_rows:
        buckets: dict[str, list[str]] = {k: [] for k in CONTACT_FIELD_KEYS}
        for header, field in mapping.items():
            if not field or field not in buckets:
                continue
            val = (rec.get(header) or "").strip()
            if val:
                buckets[field].append(val)

        company = _join_parts(buckets["company"])
        city_paren = re.match(r"^\((.+)\)$", company.strip()) if company else None
        if city_paren:
            if not buckets["city"]:
                buckets["city"].append(city_paren.group(1).strip())
            company = last_company
        else:
            company = company or last_company
            if _join_parts(buckets["company"]) and not city_paren:
                last_company = _join_parts(buckets["company"])

        email = _emails(*buckets["email"])
        vessel = _join_parts(buckets["vessel_name"], sep="; ")
        remarks = _join_parts(buckets["other_info"], sep="; ")
        if not vessel and remarks:
            vn, oi, _sites = _remarks_fields(remarks)
            if vn:
                vessel, remarks = vn, oi

        row = _person_row(
            contact_name=_join_parts(buckets["contact_name"]),
            designation=_join_parts(buckets["designation"]),
            department=_join_parts(buckets["department"]),
            company=company,
            company_type=_join_parts(buckets["company_type"]),
            vessel_name=vessel,
            email=email,
            off_phone=_join_parts(buckets["off_phone"], sep=" ; "),
            mob_phone=_join_parts(buckets["mob_phone"], sep=" ; "),
            wechat=_join_parts(buckets["wechat"]),
            whatsapp=_join_parts(buckets["whatsapp"]),
            website_address=_join_parts(buckets["website_address"]),
            office_address=_join_parts(buckets["office_address"]),
            other_info=remarks,
            status=_join_parts(buckets["status"]) or "Active",
            country=_join_parts(buckets["country"]),
            city=_join_parts(buckets["city"]),
            trade=_join_parts(buckets["trade"]),
            role=_join_parts(buckets["role"]),
            fax=_join_parts(buckets["fax"], sep=" ; "),
        )
        if not (
            row.get("contact_name")
            or row.get("email")
            or row.get("mob_phone")
            or row.get("off_phone")
        ):
            continue
        parsed.append(row)
    return parsed


async def import_owners_csv(raw: bytes, filename: str = "") -> dict[str, Any]:
    headers, csv_rows = parse_csv_table(raw)
    if not headers:
        raise ValueError("CSV has no header row.")
    if not csv_rows:
        raise ValueError("CSV has no data rows.")

    heuristic = heuristic_mapping(headers)
    ai_map: dict[str, str | None] = {}
    try:
        ai_map = await ai_map_headers(headers, csv_rows)
    except Exception as exc:  # noqa: BLE001
        logger.warning("CSV AI mapping failed (%s); using header library only", exc)

    mapping = _merge_mapping(headers, heuristic, ai_map)
    if not any(mapping.values()):
        raise ValueError("Could not map any CSV columns to contact fields.")

    parsed = rows_from_csv(csv_rows, mapping)
    stats = import_owner_contacts(parsed)
    stats["filename"] = filename
    stats["mapped_columns"] = {h: f for h, f in mapping.items() if f}
    logger.info("Owners CSV import %s → %s", filename, stats)
    return stats


OWNERS_DOC_EXTRACT_PROMPT = """\
You extract OWNERS / BROKER CONTACT rows from a directory file
(CSV dump, Excel dump, JSON, or PDF).

Return ONLY valid JSON: {{"contacts": [ ... ]}}

Every object MUST use these keys ("" if unknown — never invent):
contact_name, designation, department, company, company_type, vessel_name,
email, off_phone, mob_phone, wechat, whatsapp, website_address, office_address,
other_info, status, country, city, trade, role, fax

Quality rules (shipbroking owners directory):
- ONE ROW PER PERSON (PIC). Shared desk email may repeat on each named PIC.
- company = company / desk name only. Carry it forward when the file groups
  people under a company heading.
- office_address, city, country are THREE separate fields when possible.
- trade = cargo / fleet focus (CPP, Chemical, MR, small tankers) — NOT company.
- vessel_name = ship names only, semicolon-separated. NEVER put ships in other_info.
- other_info = remarks / notes only. NEVER vessel names.
- email lowercase; merge PIC + office emails comma-separated.
- off_phone = office/Tel; mob_phone = mobile. Keep +international format.
- role = Owner / Broker / Operator / Charterer only if stated.
- status = Active or Inactive (default Active).
- Title Case names, company, address, city, country, trade.
- Skip blank / header / total rows. Extract EVERY real contact.

FILE NAME: {filename}
"""


def _ext(filename: str) -> str:
    return (filename or "").rsplit(".", 1)[-1].lower() if "." in (filename or "") else ""


def parse_json_table(raw: bytes) -> tuple[list[str], list[dict[str, str]]]:
    text = raw.decode("utf-8-sig", errors="replace").strip()
    obj = json.loads(text)
    records: list[Any]
    if isinstance(obj, list):
        records = obj
    elif isinstance(obj, dict):
        records = obj.get("contacts") or obj.get("rows") or obj.get("data") or obj.get("owners")
        if not isinstance(records, list):
            records = [obj]
    else:
        raise ValueError("JSON must be an object or an array of objects.")
    rows: list[dict[str, str]] = []
    headers: list[str] = []
    seen: set[str] = set()
    for rec in records:
        if not isinstance(rec, dict):
            continue
        cleaned = {
            str(k).strip(): "" if v is None else str(v).strip()
            for k, v in rec.items()
            if k is not None and str(k).strip()
        }
        if not any(cleaned.values()):
            continue
        rows.append(cleaned)
        for k in cleaned:
            if k not in seen:
                seen.add(k)
                headers.append(k)
    return headers, rows


def _cells(row: Any) -> list[str]:
    return ["" if c is None else str(c).strip() for c in row]


def _sheet_dicts(matrix: list[list[str]]) -> tuple[list[str], list[dict[str, str]]]:
    if len(matrix) < 2:
        return [], []
    header_idx = 0
    best = 0
    for i, row in enumerate(matrix[:12]):
        n = sum(1 for c in row if c)
        if n > best:
            best = n
            header_idx = i
    headers = [h or f"col_{i+1}" for i, h in enumerate(matrix[header_idx])]
    # unique headers
    used: dict[str, int] = {}
    uniq: list[str] = []
    for h in headers:
        key = h
        if key in used:
            used[key] += 1
            key = f"{h}_{used[h]}"
        else:
            used[key] = 1
        uniq.append(key)
    rows: list[dict[str, str]] = []
    for row in matrix[header_idx + 1 :]:
        rec = {uniq[i]: (row[i] if i < len(row) else "") for i in range(len(uniq))}
        if any(rec.values()):
            rows.append(rec)
    return uniq, rows


def parse_excel_table(raw: bytes, filename: str) -> tuple[list[str], list[dict[str, str]]]:
    ext = _ext(filename)
    matrices: list[list[list[str]]] = []
    if ext == "xls":
        import xlrd

        book = xlrd.open_workbook(file_contents=raw)
        for sh in book.sheets():
            matrix = []
            for r in range(sh.nrows):
                cells = _cells(sh.row_values(r))
                if any(cells):
                    matrix.append(cells)
            if matrix:
                matrices.append(matrix)
    else:
        from openpyxl import load_workbook

        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        for ws in wb.worksheets:
            matrix = []
            for row in ws.iter_rows(values_only=True):
                cells = _cells(row)
                if any(cells):
                    matrix.append(cells)
            if matrix:
                matrices.append(matrix)
        wb.close()

    all_headers: list[str] = []
    all_rows: list[dict[str, str]] = []
    seen_h: set[str] = set()
    for matrix in matrices:
        headers, rows = _sheet_dicts(matrix)
        for h in headers:
            if h not in seen_h:
                seen_h.add(h)
                all_headers.append(h)
        all_rows.extend(rows)
    return all_headers, all_rows


async def import_mapped_table(
    headers: list[str],
    table_rows: list[dict[str, str]],
    filename: str,
) -> dict[str, Any]:
    if not headers or not table_rows:
        raise ValueError("No table rows found in the file.")
    heuristic = heuristic_mapping(headers)
    ai_map: dict[str, str | None] = {}
    try:
        ai_map = await ai_map_headers(headers, table_rows)
    except Exception as exc:  # noqa: BLE001
        logger.warning("AI column mapping failed (%s); using header library", exc)
    mapping = _merge_mapping(headers, heuristic, ai_map)
    if not any(mapping.values()):
        raise ValueError("Could not map any columns to contact fields.")
    parsed = rows_from_csv(table_rows, mapping)
    stats = import_owner_contacts(parsed)
    stats["filename"] = filename
    stats["mapped_columns"] = {h: f for h, f in mapping.items() if f}
    return stats


def _contacts_to_person_rows(contacts: list[dict[str, str]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    last_company = ""
    for c in contacts:
        company = (c.get("company") or "").strip() or last_company
        if (c.get("company") or "").strip():
            last_company = company
        vessel = (c.get("vessel_name") or "").strip()
        remarks = (c.get("other_info") or "").strip()
        if not vessel and remarks:
            vn, oi, _sites = _remarks_fields(remarks)
            if vn:
                vessel, remarks = vn, oi
        row = _person_row(
            contact_name=c.get("contact_name") or "",
            designation=c.get("designation") or "",
            department=c.get("department") or "",
            company=company,
            company_type=c.get("company_type") or "",
            vessel_name=vessel,
            email=c.get("email") or "",
            off_phone=c.get("off_phone") or "",
            mob_phone=c.get("mob_phone") or "",
            wechat=c.get("wechat") or "",
            whatsapp=c.get("whatsapp") or "",
            website_address=c.get("website_address") or "",
            office_address=c.get("office_address") or "",
            other_info=remarks,
            status=c.get("status") or "Active",
            country=c.get("country") or "",
            city=c.get("city") or "",
            trade=c.get("trade") or "",
            role=c.get("role") or "",
            fax=c.get("fax") or "",
        )
        out.append(row)
    return out


async def extract_owners_from_document(raw: bytes, filename: str) -> list[dict[str, str]]:
    ext = _ext(filename)
    if ext == "xls":
        headers, rows = parse_excel_table(raw, filename)
        text = "\n".join(
            ["\t".join(headers)]
            + ["\t".join(rec.get(h, "") for h in headers) for rec in rows[:400]]
        )
        blocks = [{"type": "text", "text": f"[Attachment: {filename}]\n{text[:40000]}"}]
    else:
        blocks = files_to_content_blocks(
            [{"filename": filename, "content": raw, "content_type": ""}]
        )
    if not blocks:
        raise ValueError("Could not read this file.")
    user_content: list[Any] = list(blocks)
    user_content.append(
        {
            "type": "text",
            "text": OWNERS_DOC_EXTRACT_PROMPT.format(filename=filename or "upload"),
        }
    )
    resp = await claude_client.chat.completions.create(
        model=settings.CLAUDE_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You extract shipbroker owners-directory contacts with high accuracy. "
                    "Ship names only in vessel_name. Remarks only in other_info. "
                    "Output only valid JSON."
                ),
            },
            {"role": "user", "content": user_content},
        ],
        temperature=0.0,
        max_tokens=8192,
    )
    text = resp.choices[0].message.content or ""
    contacts = _parse_contact_json(text)
    if not contacts:
        try:
            obj = json.loads(re.sub(r"```(?:json)?", "", text).replace("```", "").strip())
            if isinstance(obj, list):
                contacts = [
                    {k: str(r.get(k) or "") for k in CONTACT_FIELD_KEYS}
                    for r in obj
                    if isinstance(r, dict)
                ]
        except json.JSONDecodeError:
            contacts = []
    if not contacts:
        raise ValueError("The agent could not extract contacts from this file.")
    return _contacts_to_person_rows(contacts)


async def import_owners_file(raw: bytes, filename: str = "") -> dict[str, Any]:
    """Prefer the proven owners-list Excel layouts; otherwise map columns / AI-extract."""
    ext = _ext(filename)
    plog.info("Owners", "Upload received", file=filename, bytes=len(raw), ext=ext)

    def _finish(parsed: list[dict[str, str]], mode: str) -> dict[str, Any]:
        plog.info("Owners", "Importing rows", file=filename, mode=mode, rows=len(parsed))
        stats = import_owner_contacts(parsed)
        stats["filename"] = filename
        stats["extract_mode"] = mode
        plog.info(
            "Owners",
            "Import complete",
            file=filename,
            mode=mode,
            inserted=stats.get("inserted"),
            updated=stats.get("updated"),
        )
        return stats

    if ext in ("xlsx", "xlsm"):
        with plog.step("Owners", "Parse Excel (.xlsx)", file=filename):
            dedicated = parse_owners_xlsx_bytes(raw)
        if len(dedicated) >= 20:
            return _finish(dedicated, "owners_xlsx_layout")
        headers, rows = parse_excel_table(raw, filename)
        return await import_mapped_table(headers, rows, filename)
    if ext == "xls":
        with plog.step("Owners", "Parse Excel (.xls)", file=filename):
            dedicated = parse_owners_xls_bytes(raw)
        if len(dedicated) >= 20:
            return _finish(dedicated, "owners_xls_layout")
        headers, rows = parse_excel_table(raw, filename)
        return await import_mapped_table(headers, rows, filename)
    if ext == "csv":
        return await import_owners_csv(raw, filename)
    if ext == "json":
        headers, rows = parse_json_table(raw)
        return await import_mapped_table(headers, rows, filename)
    if ext == "pdf":
        with plog.step("Owners", "Agent scanning PDF", file=filename):
            parsed = await extract_owners_from_document(raw, filename)
        return _finish(parsed, "document")
    raise ValueError("Supported files: CSV, Excel (.xlsx / .xls), JSON, PDF.")
