"""
Vessel Library enrichment — Claude + Anthropic web_search (server tool).

Runs after Phase-1 (inbox/extraction already complete). Fills blank library /
pending-review particulars and marks which fields came from enrichment
(`api_sourced`) for yellow UI borders.

Order: only Claude web search (no VesselAPI / MyShipTracking).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any

from anthropic import Anthropic

from config import settings
from sse_manager import sse_manager

import pipeline_log as plog

logger = logging.getLogger(__name__)

# Fields we may fill from enrichment (yellow border in UI).
ENRICH_FIELDS = ("imo_no", "call_sign", "vessel_type", "flag")
PROVIDER = "claude_web_search"
WEB_SEARCH_TOOL_TYPES = (
    "web_search_20250305",
    "web_search_20260209",
    "web_search_20260318",
)

_EMPTY = frozenset({
    "", "-", "—", "–", ".", "..", "n/a", "na", "none", "null", "unknown", "tba", "tbc", "tbd",
})
_NAME_PREFIX_RE = re.compile(r"^(?:m\s*/\s*[tv]|m\.?\s*[tv]\.?|mv|mt)\s+", re.I)
_IMO_RE = re.compile(r"^\d{7}$")

_STATUS: dict[str, Any] = {
    "running": False,
    "job_id": "",
    "done": 0,
    "total": 0,
    "matched": 0,
    "pending": 0,
    "provider": PROVIDER,
    "error": "",
    "started_at": "",
    "finished_at": "",
}

_QUEUE: deque[tuple[Any, dict[str, Any], str]] = deque()
_QUEUED_KEYS: set[str] = set()
_ACTIVE_KEYS: set[str] = set()
_ACTIVE_ROW_STATUS: dict[str, str] = {}
_WORKER_TASK: asyncio.Task | None = None

_PROMPT = """You are looking up ship particulars for a shipbroker vessel library.

Vessel to identify:
- Name: {name}
- Year built (from broker mail, may be wrong/blank): {year}
- DWT (from broker mail, may be wrong/blank): {dwt}

Use web search. Prefer AIS/registry sources (MarineTraffic, VesselFinder, class society, flag registry).

Return ONLY valid JSON (no markdown) with these keys:
{{
  "matched": true/false,
  "confidence": "high"|"medium"|"low",
  "imo_no": "7-digit IMO or empty string",
  "call_sign": "string or empty",
  "vessel_type": "string or empty",
  "flag": "string or empty",
  "matched_name": "registered name or empty",
  "year_built": "YYYY or empty",
  "dwt": "string or empty",
  "sources": ["url1"],
  "notes": "short reason if unmatched or uncertain"
}}

Rules:
- Never invent an IMO. If unsure, matched=false and imo_no="".
- If multiple ships share the name, use year/DWT to disambiguate; if still unsure, matched=false.
- Prefer confidence high/medium only when an IMO is confirmed by a source.
"""


def get_enrichment_status() -> dict[str, Any]:
    out = dict(_STATUS)
    out["pending"] = len(_QUEUED_KEYS) + len(_ACTIVE_KEYS)
    out["running"] = bool(_WORKER_TASK and not _WORKER_TASK.done()) or bool(out["pending"])
    return out


def _clean(val: Any) -> str:
    s = str(val or "").strip()
    return "" if s.lower() in _EMPTY else s


def _norm_name(name: str) -> str:
    s = _NAME_PREFIX_RE.sub("", _clean(name)).upper()
    s = s.replace("_", " ").replace("-", " ")
    s = re.sub(r"[^A-Z0-9 ]+", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _needs_enrichment(row: dict[str, Any]) -> bool:
    return any(not _clean(row.get(f)) for f in ENRICH_FIELDS)


def _parse_api_sourced(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(x) for x in raw if str(x) in ENRICH_FIELDS]
    if isinstance(raw, str) and raw.strip().startswith("["):
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                return [str(x) for x in data if str(x) in ENRICH_FIELDS]
        except Exception:  # noqa: BLE001
            return []
    return []


def _cache_payload_status(payload: dict[str, Any]) -> str:
    status = _clean(payload.get("_status"))
    return status or ""


def _extract_json(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return {}
        try:
            data = json.loads(m.group(0))
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}


def _text_from_message(message: Any) -> str:
    parts: list[str] = []
    for block in getattr(message, "content", None) or []:
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", "") or "")
    return "\n".join(parts).strip()


def flatten_web_result(data: dict[str, Any]) -> dict[str, Any]:
    """Normalize Claude JSON into enrichment flat fields."""
    matched = bool(data.get("matched"))
    imo = _clean(data.get("imo_no") or data.get("imo"))
    if imo and not _IMO_RE.match(imo):
        # Reject non-7-digit IMOs
        digits = re.sub(r"\D", "", imo)
        imo = digits if _IMO_RE.match(digits) else ""
        if not imo:
            matched = False
    conf = str(data.get("confidence") or "").lower()
    if matched and conf == "low":
        matched = False
    if matched and not imo and not _clean(data.get("vessel_type")):
        matched = False
    return {
        "provider": PROVIDER,
        "matched": matched,
        "imo_no": imo if matched else "",
        "call_sign": _clean(data.get("call_sign")) if matched else "",
        "vessel_type": _clean(data.get("vessel_type")) if matched else "",
        "flag": _clean(data.get("flag")) if matched else "",
        "matched_name": _clean(data.get("matched_name")) if matched else "",
        "confidence": conf,
        "notes": _clean(data.get("notes")),
        "sources": data.get("sources") if isinstance(data.get("sources"), list) else [],
    }


def apply_enrichment_to_row(row: dict[str, Any], flat: dict[str, Any]) -> dict[str, Any]:
    """Fill blank enrich fields; return updated row + api_sourced list."""
    sourced = set(_parse_api_sourced(row.get("api_sourced")))
    out = dict(row)
    mapping = {
        "imo_no": flat.get("imo_no") or "",
        "call_sign": flat.get("call_sign") or "",
        "vessel_type": flat.get("vessel_type") or "",
        "flag": flat.get("flag") or "",
    }
    for field, val in mapping.items():
        val = _clean(val)
        if not val:
            continue
        if not _clean(out.get(field)):
            out[field] = val
            sourced.add(field)
    out["api_sourced"] = sorted(sourced)
    out["enrichment_provider"] = flat.get("provider") or PROVIDER
    return out


def _cache_upsert(
    db,
    match_key: str,
    row: dict[str, Any],
    provider: str,
    *,
    status: str = "done",
    error: str = "",
) -> None:
    if not match_key:
        return
    payload = {f: _clean(row.get(f)) for f in ENRICH_FIELDS}
    payload["vessel_name"] = _clean(row.get("vessel_name"))
    payload["year_built"] = _clean(row.get("year_built"))
    payload["dwt"] = _clean(row.get("dwt"))
    payload["_status"] = status
    payload["_error"] = error[:300] if error else ""
    data = {
        "match_key": match_key,
        "payload": payload,
        "api_sourced": row.get("api_sourced") or [],
        "provider": provider or PROVIDER,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    existing = (
        db.table("vessel_enrichment_cache")
        .select("match_key")
        .eq("match_key", match_key)
        .execute()
    ).data or []
    if existing:
        db.table("vessel_enrichment_cache").update(data).eq("match_key", match_key).execute()
    else:
        db.table("vessel_enrichment_cache").insert(data).execute()


def _cache_load_all(db) -> dict[str, dict[str, Any]]:
    rows = (
        db.table("vessel_enrichment_cache")
        .select("match_key, payload, api_sourced, provider")
        .execute()
    ).data or []
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        key = _clean(r.get("match_key"))
        if not key:
            continue
        out[key] = {
            "payload": r.get("payload") if isinstance(r.get("payload"), dict) else {},
            "api_sourced": _parse_api_sourced(r.get("api_sourced")),
            "provider": _clean(r.get("provider")),
        }
    return out


def _row_runtime_status(key: str) -> str:
    if key in _ACTIVE_KEYS:
        return _ACTIVE_ROW_STATUS.get(key) or "running"
    if key in _QUEUED_KEYS:
        return "pending"
    return ""


def merge_cache_into_rows(db, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply enrichment cache onto pending / library rows for API responses."""
    if not rows:
        return rows
    cache = _cache_load_all(db)
    from vessel_library import match_key_from_particulars

    merged: list[dict[str, Any]] = []
    for r in rows:
        row = dict(r)
        row["api_sourced"] = _parse_api_sourced(row.get("api_sourced"))
        key = _clean(row.get("match_key")) or match_key_from_particulars(row)
        row["match_key"] = key
        hit = cache.get(key)
        cache_status = ""
        if hit:
            payload = hit.get("payload") or {}
            cache_status = _cache_payload_status(payload)
            sourced = set(row["api_sourced"])
            for f in ENRICH_FIELDS:
                val = _clean(payload.get(f))
                if val and not _clean(row.get(f)):
                    row[f] = val
                    sourced.add(f)
            for f in hit.get("api_sourced") or []:
                if f in ENRICH_FIELDS and _clean(row.get(f)):
                    sourced.add(f)
            row["api_sourced"] = sorted(sourced)
            if hit.get("provider"):
                row["enrichment_provider"] = hit["provider"]
        live_status = _row_runtime_status(key)
        status = cache_status or live_status or ("done" if not _needs_enrichment(row) else "pending")
        row["enrichment_status"] = status
        row["enrichment_ready"] = status in {"done", "miss", "error"}
        merged.append(row)
    return merged


async def _emit(job_id: str, event_type: str, data: dict[str, Any]) -> None:
    payload = dict(data)
    if job_id:
        await sse_manager.send(job_id, event_type, payload)
    await sse_manager.send("live", event_type, {**payload, "job_id": job_id})


def _collect_targets(db, *, missing_only: bool = True) -> list[dict[str, Any]]:
    from vessel_library import detect_new_vessels, list_library, match_key_from_particulars

    targets: list[dict[str, Any]] = []
    for r in list_library(db):
        item = dict(r)
        item["_source"] = "library"
        item["match_key"] = _clean(item.get("match_key")) or match_key_from_particulars(item)
        if _clean(item.get("vessel_name")) and (not missing_only or _needs_enrichment(item)):
            targets.append(item)
    for r in detect_new_vessels(db):
        item = dict(r)
        item["_source"] = "pending_review"
        item["match_key"] = _clean(item.get("match_key")) or match_key_from_particulars(item)
        if _clean(item.get("vessel_name")) and (not missing_only or _needs_enrichment(item)):
            targets.append(item)

    by_key: dict[str, dict[str, Any]] = {}
    for t in targets:
        key = t["match_key"] or f"name:{_norm_name(t.get('vessel_name') or '')}"
        prev = by_key.get(key)
        if prev and prev.get("_source") == "library":
            continue
        by_key[key] = t
    out = list(by_key.values())
    out.sort(key=lambda r: (_clean(r.get("vessel_name")) or "").upper())
    return out


def _enqueue_targets(db, targets: list[dict[str, Any]], job_id: str) -> int:
    cache = _cache_load_all(db)
    added = 0
    for src in targets:
        key = _clean(src.get("match_key"))
        if not key:
            continue
        payload = (cache.get(key) or {}).get("payload") or {}
        if _cache_payload_status(payload) in {"done", "miss", "error"}:
            continue
        if key in _QUEUED_KEYS or key in _ACTIVE_KEYS:
            continue
        _QUEUE.append((db, dict(src), job_id))
        _QUEUED_KEYS.add(key)
        added += 1
    return added


def _ensure_worker_started() -> None:
    global _WORKER_TASK
    if _WORKER_TASK and not _WORKER_TASK.done():
        return
    loop = asyncio.get_running_loop()
    _WORKER_TASK = loop.create_task(_drain_enrichment_queue(), name="vessel-enrichment-queue")


def _persist_library_row(db, row: dict[str, Any]) -> None:
    row_id = row.get("id")
    if not row_id:
        return
    patch = {f: _clean(row.get(f)) for f in ENRICH_FIELDS}
    patch["api_sourced"] = row.get("api_sourced") or []
    patch["updated_at"] = datetime.now(timezone.utc).isoformat()
    db.table("vessel_library").update(patch).eq("id", row_id).execute()


def _enrich_one_target_sync(db, client: "_WebSearchClient", src: dict[str, Any]) -> dict[str, Any]:
    name = _clean(src.get("vessel_name")) or "?"
    flat = search_claude_web(client, src)
    match_key = _clean(src.get("match_key"))
    if flat.get("matched"):
        updated = apply_enrichment_to_row(src, flat)
        if updated.get("id"):
            _persist_library_row(db, updated)
        _cache_upsert(db, match_key, updated, PROVIDER, status="done")
        status = "HIT"
    else:
        updated = dict(src)
        _cache_upsert(db, match_key, updated, PROVIDER, status="miss", error=flat.get("notes") or "")
        status = "MISS"
    return {
        "matched": bool(flat.get("matched")),
        "row": {
            "vessel_name": name,
            "year_built": _clean(src.get("year_built")),
            "dwt": _clean(src.get("dwt")),
            "source": src.get("_source"),
            "status": status,
            "imo_no": flat.get("imo_no") or "",
            "call_sign": flat.get("call_sign") or "",
            "vessel_type": flat.get("vessel_type") or "",
            "flag": flat.get("flag") or "",
            "matched_name": flat.get("matched_name") or "",
            "confidence": flat.get("confidence") or "",
            "notes": flat.get("notes") or "",
            "web_search_requests": flat.get("web_search_requests"),
        },
    }


class _WebSearchClient:
    """Sync Claude client with web_search tool; picks a working tool type once."""

    def __init__(self, api_key: str, model: str):
        self.client = Anthropic(api_key=api_key)
        self.model = model
        self.tool_type: str | None = None

    def _create(self, tool_type: str, src: dict[str, Any]):
        name = _clean(src.get("vessel_name")) or "?"
        year = _clean(src.get("year_built")) or "(unknown)"
        dwt = _clean(src.get("dwt")) or "(unknown)"
        return self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": _PROMPT.format(name=name, year=year, dwt=dwt),
            }],
            tools=[{
                "type": tool_type,
                "name": "web_search",
                "max_uses": 3,
            }],
        )

    def ensure_tool(self) -> str:
        if self.tool_type:
            return self.tool_type
        last_err: Exception | None = None
        probe = {"vessel_name": "Ever Given", "year_built": "2018", "dwt": "199629"}
        for tt in WEB_SEARCH_TOOL_TYPES:
            try:
                self._create(tt, probe)
                self.tool_type = tt
                logger.info("[Enrich] Using web search tool type %s", tt)
                return tt
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                logger.warning("[Enrich] web search tool %s failed: %s", tt, exc)
        raise RuntimeError(f"Anthropic web_search not available: {last_err}")

    def lookup(self, src: dict[str, Any]) -> dict[str, Any]:
        tt = self.ensure_tool()
        msg = self._create(tt, src)
        data = _extract_json(_text_from_message(msg))
        flat = flatten_web_result(data)
        usage = getattr(msg, "usage", None)
        searches = None
        if usage is not None:
            stu = getattr(usage, "server_tool_use", None)
            if stu is not None:
                searches = getattr(stu, "web_search_requests", None)
        flat["web_search_requests"] = searches
        return flat


def search_claude_web(client: _WebSearchClient, src: dict[str, Any]) -> dict[str, Any]:
    return client.lookup(src)


def enrich_targets_sync(
    db,
    targets: list[dict[str, Any]],
    *,
    on_progress: Any = None,
) -> dict[str, Any]:
    """Run Claude web enrichment for targets; persist cache / library blanks."""
    api_key = (getattr(settings, "ANTHROPIC_API_KEY", None) or "").strip()
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    model = (getattr(settings, "CLAUDE_MODEL", None) or "claude-haiku-4-5").strip()
    client = _WebSearchClient(api_key, model)
    client.ensure_tool()

    matched = 0
    misses = 0
    errors = 0
    rows_out: list[dict[str, Any]] = []

    for i, src in enumerate(targets, 1):
        name = _clean(src.get("vessel_name")) or "?"
        try:
            result = _enrich_one_target_sync(db, client, src)
            row_result = result["row"]
            if result["matched"]:
                matched += 1
            else:
                misses += 1
            rows_out.append(row_result)
            if on_progress:
                on_progress(i, len(targets), matched, row_result)
            _STATUS["done"] = i
            _STATUS["matched"] = matched
        except Exception as exc:  # noqa: BLE001
            errors += 1
            logger.warning("[Enrich] %s failed: %s", name, exc)
            _cache_upsert(
                db,
                _clean(src.get("match_key")),
                src,
                PROVIDER,
                status="error",
                error=str(exc),
            )
            _STATUS["done"] = i
            _STATUS["error"] = str(exc)
            rows_out.append({
                "vessel_name": name,
                "year_built": _clean(src.get("year_built")),
                "dwt": _clean(src.get("dwt")),
                "source": src.get("_source"),
                "status": "ERR",
                "error": str(exc),
            })
            if on_progress:
                on_progress(i, len(targets), matched, rows_out[-1])
        time.sleep(0.15)

    return {
        "matched": matched,
        "misses": misses,
        "errors": errors,
        "total": len(targets),
        "rows": rows_out,
    }


async def run_vessel_library_enrichment(job_id: str, db=None) -> dict[str, Any]:
    """Queue missing vessel particulars for incremental Claude web enrichment."""
    from database import supabase as default_db

    db = db or default_db
    api_key = (getattr(settings, "ANTHROPIC_API_KEY", None) or "").strip()
    if not api_key:
        logger.warning("[Enrich] Skipped — no ANTHROPIC_API_KEY")
        await _emit(job_id, "vessel_library_enrichment_done", {
            "skipped": True,
            "reason": "no_api_keys",
            "matched": 0,
            "total": 0,
        })
        return {"skipped": True, "matched": 0, "total": 0}

    if _STATUS.get("running"):
        targets = _collect_targets(db, missing_only=True)
        added = _enqueue_targets(db, targets, job_id)
        if added:
            _STATUS["total"] += added
        return {"queued": added, "running": True}

    targets = _collect_targets(db, missing_only=True)
    if not targets:
        return {"matched": 0, "total": 0}
    added = _enqueue_targets(db, targets, job_id)
    if not added:
        return {"queued": 0, "total": 0}
    _STATUS.update({
        "running": True,
        "job_id": job_id or _STATUS.get("job_id") or "",
        "done": 0 if not _STATUS.get("pending") else _STATUS.get("done", 0),
        "total": added if not _STATUS.get("pending") else _STATUS.get("total", 0) + added,
        "matched": 0 if not _STATUS.get("pending") else _STATUS.get("matched", 0),
        "pending": len(_QUEUED_KEYS) + len(_ACTIVE_KEYS),
        "provider": PROVIDER,
        "error": "",
        "started_at": _STATUS.get("started_at") or datetime.now(timezone.utc).isoformat(),
        "finished_at": "",
    })
    plog.info("Enrich", "▶ library enrichment", job=job_id[:8] if job_id else "", targets=_STATUS["total"])
    await _emit(job_id, "vessel_library_enrichment_started", {
        "total": _STATUS["total"],
        "done": _STATUS["done"],
        "message": "Enriching vessel library via Claude web search…",
    })
    _ensure_worker_started()
    return {"queued": added, "total": _STATUS["total"], "running": True}


async def _drain_enrichment_queue() -> None:
    from database import supabase as default_db

    api_key = (getattr(settings, "ANTHROPIC_API_KEY", None) or "").strip()
    if not api_key:
        _STATUS["running"] = False
        return
    model = (getattr(settings, "CLAUDE_MODEL", None) or "claude-haiku-4-5").strip()
    client = _WebSearchClient(api_key, model)
    try:
        client.ensure_tool()
        while _QUEUE:
            db, src, job_id = _QUEUE.popleft()
            db = db or default_db
            key = _clean(src.get("match_key"))
            if key:
                _QUEUED_KEYS.discard(key)
                _ACTIVE_KEYS.add(key)
                _ACTIVE_ROW_STATUS[key] = "running"
            try:
                result = await asyncio.to_thread(_enrich_one_target_sync, db, client, src)
                if result.get("matched"):
                    _STATUS["matched"] = int(_STATUS.get("matched") or 0) + 1
                await _emit(job_id, "vessel_library_enrichment_progress", {
                    "done": int(_STATUS.get("done") or 0) + 1,
                    "total": _STATUS.get("total") or 0,
                    "matched": _STATUS.get("matched") or 0,
                    "row": result.get("row") or {},
                })
            except Exception as exc:  # noqa: BLE001
                logger.warning("[Enrich] %s failed: %s", _clean(src.get("vessel_name")) or "?", exc)
                _cache_upsert(
                    db,
                    key,
                    src,
                    PROVIDER,
                    status="error",
                    error=str(exc),
                )
                _STATUS["error"] = str(exc)
            finally:
                _STATUS["done"] = int(_STATUS.get("done") or 0) + 1
                if key:
                    _ACTIVE_KEYS.discard(key)
                    _ACTIVE_ROW_STATUS.pop(key, None)
                _STATUS["pending"] = len(_QUEUED_KEYS) + len(_ACTIVE_KEYS)
                time.sleep(0.05)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[Enrich] Crashed: %s", exc)
        _STATUS["error"] = str(exc)
    finally:
        _STATUS["running"] = False
        _STATUS["pending"] = 0
        _STATUS["finished_at"] = datetime.now(timezone.utc).isoformat()
        await _emit(_STATUS.get("job_id") or "live", "vessel_library_enrichment_done", {
            "matched": _STATUS.get("matched") or 0,
            "total": _STATUS.get("total") or 0,
            "provider": PROVIDER,
            "message": f"Vessel library enrichment done ({_STATUS.get('matched') or 0}/{_STATUS.get('total') or 0} matched)",
        })
        plog.info(
            "Enrich",
            "✓ library enrichment done",
            matched=_STATUS.get("matched") or 0,
            total=_STATUS.get("total") or 0,
            errors=1 if _STATUS.get("error") else 0,
        )
        try:
            from vessel_sync import backfill_positions_from_library

            sync_stats = backfill_positions_from_library(default_db, only_empty=True)
            if sync_stats.get("updated"):
                logger.info(
                    "[Enrich] Library→position backfill: %d row(s) updated",
                    sync_stats["updated"],
                )
        except Exception as sync_exc:  # noqa: BLE001
            logger.warning("[Enrich] Position backfill after enrichment failed: %s", sync_exc)
