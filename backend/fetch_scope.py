"""Persist the active fetch date window so Home AI summary can scope to it."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

SCOPE_PATH = Path(__file__).resolve().parent / "data" / "fetch_scope.json"


def save_fetch_scope(
    *,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    email_ids: Optional[list[str]] = None,
) -> dict[str, Any]:
    SCOPE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "date_from": (date_from or "").strip() or None,
        "date_to": (date_to or "").strip() or None,
        "email_ids": list(email_ids or []),
    }
    SCOPE_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    logger.info(
        "[FetchScope] saved date_from=%s date_to=%s email_ids=%d",
        payload["date_from"],
        payload["date_to"],
        len(payload["email_ids"]),
    )
    return payload


def clear_fetch_scope() -> None:
    if SCOPE_PATH.exists():
        SCOPE_PATH.unlink()
        logger.info("[FetchScope] cleared")


def load_fetch_scope() -> Optional[dict[str, Any]]:
    if not SCOPE_PATH.exists():
        return None
    try:
        data = json.loads(SCOPE_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        return data
    except Exception as exc:  # noqa: BLE001
        logger.warning("[FetchScope] failed to load: %s", exc)
        return None
