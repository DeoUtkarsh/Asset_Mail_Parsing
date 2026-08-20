"""
IMAP UID watermark for IDLE auto-fetch.

On watcher start we record the current highest INBOX UID and ignore everything
already in the mailbox. Only messages with a greater UID (truly new arrivals)
are fetched. Historical backfill is manual Fetch Emails + date filter only.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_LEGACY_WATERMARK = Path(__file__).resolve().parent / "data" / "imap_uid_watermark.json"


def _watermark_path() -> Path:
    override = (os.environ.get("IMAP_WATERMARK_PATH") or "").strip()
    if override:
        return Path(override)
    # Keep this file off the uvicorn --reload tree (backend/). Writing it
    # inside backend/data used to restart the API and freeze every UI spinner.
    root = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME")
    base = Path(root) if root else Path.home() / ".local" / "share"
    return base / "ShipbrokerSense" / "imap_uid_watermark.json"


WATERMARK_PATH = _watermark_path()


def _save(uid: int) -> None:
    WATERMARK_PATH.parent.mkdir(parents=True, exist_ok=True)
    WATERMARK_PATH.write_text(
        json.dumps({"max_uid": int(uid)}, indent=2),
        encoding="utf-8",
    )


def get_watermark() -> int:
    path = WATERMARK_PATH if WATERMARK_PATH.exists() else (
        _LEGACY_WATERMARK if _LEGACY_WATERMARK.exists() else None
    )
    if path is None:
        return 0
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return int(data.get("max_uid") or 0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[IdleUID] failed to load watermark: %s", exc)
        return 0


def set_watermark(uid: int) -> int:
    uid = max(0, int(uid))
    # Avoid rewriting the same file — uvicorn --reload watches backend/data.
    if WATERMARK_PATH.exists() and get_watermark() == uid:
        return uid
    _save(uid)
    return uid


def ensure_idle_baseline(current_max_uid: int) -> int:
    """
    Call once when IMAP IDLE starts: skip all mail already in INBOX.
    Empty DB + old inbox mail must NOT auto-ingest after a deploy.
    """
    uid = max(0, int(current_max_uid or 0))
    set_watermark(uid)
    logger.info(
        "[IdleUID] baseline watermark=%s — existing INBOX ignored until new mail arrives",
        uid,
    )
    return uid


def advance_watermark(seen_max_uid: int) -> int:
    """Raise watermark after an IDLE fetch (even if nothing was ingested)."""
    prev = get_watermark()
    nxt = max(prev, int(seen_max_uid or 0))
    if nxt != prev:
        set_watermark(nxt)
        logger.info("[IdleUID] watermark advanced %s → %s", prev, nxt)
    return nxt
