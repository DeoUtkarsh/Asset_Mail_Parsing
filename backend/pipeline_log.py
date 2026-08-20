"""
Terminal-friendly step logging for all major pipelines.

Tags: API, Phase1, Phase2, Ingestion, Extract, Contacts, Owners, Q88, Library, Enrich, AutoFetch, Summary
"""
from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from typing import Any

log = logging.getLogger("pipeline")


def _fmt(tag: str, msg: str, kv: dict[str, Any]) -> str:
    extra = " ".join(f"{k}={v}" for k, v in kv.items() if v is not None and v != "")
    return f"[{tag}] {msg}" + (f" — {extra}" if extra else "")


def info(tag: str, msg: str, **kv: Any) -> None:
    log.info(_fmt(tag, msg, kv))


def warn(tag: str, msg: str, **kv: Any) -> None:
    log.warning(_fmt(tag, msg, kv))


def error(tag: str, msg: str, **kv: Any) -> None:
    log.error(_fmt(tag, msg, kv))


def exception(tag: str, msg: str, **kv: Any) -> None:
    log.exception(_fmt(tag, msg, kv))


@contextmanager
def step(tag: str, msg: str, **kv: Any):
    """Log START / DONE (with elapsed seconds) / FAIL for a block."""
    info(tag, f"▶ {msg}", **kv)
    t0 = time.monotonic()
    try:
        yield
        info(tag, f"✓ {msg}", elapsed_s=round(time.monotonic() - t0, 1), **kv)
    except Exception:
        error(tag, f"✗ {msg} failed after {time.monotonic() - t0:.1f}s", **kv)
        raise
