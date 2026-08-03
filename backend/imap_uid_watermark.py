"""
IMAP UID watermark for IDLE auto-fetch.

On watcher start we record the current highest INBOX UID and ignore everything
already in the mailbox. Only messages with a greater UID (truly new arrivals)
are fetched. Historical backfill is manual Fetch Emails + date filter only.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

WATERMARK_PATH = Path(__file__).resolve().parent / "data" / "imap_uid_watermark.json"


def _save(uid: int) -> None:
    WATERMARK_PATH.parent.mkdir(parents=True, exist_ok=True)
    WATERMARK_PATH.write_text(
        json.dumps({"max_uid": int(uid)}, indent=2),
        encoding="utf-8",
    )


def get_watermark() -> int:
    if not WATERMARK_PATH.exists():
        return 0
    try:
        data = json.loads(WATERMARK_PATH.read_text(encoding="utf-8"))
        return int(data.get("max_uid") or 0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[IdleUID] failed to load watermark: %s", exc)
        return 0


def set_watermark(uid: int) -> int:
    uid = max(0, int(uid))
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
