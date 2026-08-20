"""
IMAP IDLE auto-fetch (AWS only).

When AUTO_FETCH_IMAP_IDLE=true, keep a long-lived IMAP IDLE on INBOX.
On mailbox change (new mail), run Phase-1 for UIDs newer than the watermark
only (broker filter + only-new Message-IDs). Existing inbox mail is never
backfilled on deploy — use manual Fetch Emails + date filter for history.

Does not poll/search on a timer — waits for IMAP server push via IDLE.
"""
from __future__ import annotations

import asyncio
import logging
import select
import socket
import threading
import time
import uuid
from typing import Awaitable, Callable, Optional

import pipeline_log as plog

from config import settings

logger = logging.getLogger(__name__)

Phase1Runner = Callable[[str], Awaitable[None]]
NotifyBus = Callable[[str, dict], Awaitable[None]]

# Shared with manual Fetch so only one Phase-1 runs at a time.
_phase1_lock = asyncio.Lock()
_pending_rerun = False
_watcher_task: Optional[asyncio.Task] = None
_stop = threading.Event()
# Job currently holding the Phase-1 lock (manual or IDLE) — for late UI attach.
_active_job_id: Optional[str] = None


def phase1_lock() -> asyncio.Lock:
    return _phase1_lock


def get_active_phase1_job_id() -> Optional[str]:
    """UUID of the in-flight Phase-1 job, or None if idle."""
    return _active_job_id


async def run_phase1_exclusive(
    runner: Phase1Runner,
    *,
    job_id: str | None = None,
    notify_bus: NotifyBus | None = None,
    source: str = "manual",
    wait: bool = True,
) -> str:
    """
    Run Phase 1 under a lock.

    wait=True  — queue behind the current run (manual Fetch).
    wait=False — if busy, mark pending re-run after current finishes (IDLE).
    """
    global _pending_rerun, _active_job_id

    if not wait and _phase1_lock.locked():
        _pending_rerun = True
        plog.info("AutoFetch", "Phase 1 busy — queued rerun after current", source=source)
        return ""

    async with _phase1_lock:
        while True:
            _pending_rerun = False
            jid = job_id or str(uuid.uuid4())
            job_id = None  # only first iteration may reuse caller id
            _active_job_id = jid
            if notify_bus and source != "manual":
                await notify_bus(jid, {"source": source})
            plog.info("AutoFetch", "▶ Phase 1 starting", job=jid[:8], source=source)
            try:
                await runner(jid)
            except Exception:
                plog.exception("AutoFetch", "Phase 1 crashed", job=jid[:8])
            if not _pending_rerun:
                if _active_job_id == jid:
                    _active_job_id = None
                return jid
            plog.info("AutoFetch", "Pending mailbox change — running Phase 1 again")
            source = "imap_idle_queued"


def _imap_idle_once(idle_timeout_sec: float = 1740.0) -> bool:
    """
    Connect, IDLE until EXISTS/RECENT or timeout/error.
    Returns True if mailbox activity suggested new mail.
    """
    import imaplib

    mail = imaplib.IMAP4_SSL(settings.IMAP_SERVER, settings.IMAP_PORT)
    try:
        mail.login(settings.EMAIL_USER, settings.EMAIL_PASSWORD)
        typ, _ = mail.select("INBOX")
        if typ != "OK":
            raise RuntimeError(f"IMAP SELECT failed: {typ}")

        sock = mail.socket()
        tag = mail._new_tag()
        if isinstance(tag, bytes):
            tag_s = tag.decode()
        else:
            tag_s = str(tag)

        mail.send(f"{tag_s} IDLE\r\n".encode("ascii"))
        # Wait for continuation "+"
        sock.settimeout(30)
        cont = mail.readline()
        if not cont or not cont.startswith(b"+"):
            raise RuntimeError(f"IMAP IDLE not accepted: {cont!r}")

        plog.info("AutoFetch", "IMAP IDLE listening", timeout_s=int(idle_timeout_sec))
        deadline = time.monotonic() + idle_timeout_sec
        saw_change = False
        while not _stop.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(min(60.0, remaining))
            try:
                ready, _, _ = select.select([sock], [], [], min(60.0, remaining))
            except (ValueError, OSError) as exc:
                logger.warning("[AutoFetch] select error during IDLE: %s", exc)
                break
            if not ready:
                continue
            try:
                line = mail.readline()
            except (socket.timeout, TimeoutError):
                continue
            except OSError as exc:
                logger.warning("[AutoFetch] readline error during IDLE: %s", exc)
                break
            if not line:
                break
            upper = line.upper()
            if b"EXISTS" in upper or b"RECENT" in upper:
                saw_change = True
                break
            if line.startswith(b"* BYE") or b" OK" in upper and tag_s.encode() in line:
                break

        # Exit IDLE
        try:
            sock.settimeout(15)
            mail.send(b"DONE\r\n")
            mail.readline()
        except Exception as exc:  # noqa: BLE001
            logger.debug("[AutoFetch] DONE cleanup: %s", exc)

        return saw_change
    finally:
        try:
            mail.logout()
        except Exception:  # noqa: BLE001
            try:
                mail.shutdown()
            except Exception:  # noqa: BLE001
                pass


def _idle_thread_main(loop: asyncio.AbstractEventLoop, on_change: Callable[[], None]) -> None:
    reconnect = max(5, int(settings.AUTO_FETCH_IDLE_RECONNECT_SEC or 30))
    # Let uvicorn accept HTTP first. Gmail SSL in this process used to freeze
    # the interpreter and reset the Vite proxy (ECONNRESET / empty tabs).
    if _stop.wait(2.0):
        return
    try:
        from imap_client import get_inbox_max_uid
        from imap_uid_watermark import ensure_idle_baseline

        ensure_idle_baseline(get_inbox_max_uid())
    except Exception:
        logger.exception("[AutoFetch] Could not set IDLE UID baseline — continuing without it")

    while not _stop.is_set():
        try:
            changed = _imap_idle_once()
            if _stop.is_set():
                break
            if changed:
                plog.info("AutoFetch", "Mailbox change detected — scheduling Phase 1")
                loop.call_soon_threadsafe(on_change)
            else:
                plog.info("AutoFetch", "IDLE cycle ended — reconnecting")
        except Exception as exc:  # noqa: BLE001
            if _stop.is_set():
                break
            logger.warning("[AutoFetch] IDLE error: %s — retry in %ss", exc, reconnect)
            _stop.wait(reconnect)


async def start_imap_idle_watcher(
    runner: Phase1Runner,
    notify_bus: NotifyBus,
) -> None:
    """Start background IDLE watcher (no-op if already running or flag off).

    Returns immediately so FastAPI can serve HTTP while Gmail IMAP connects.
    """
    global _watcher_task
    if not settings.AUTO_FETCH_IMAP_IDLE:
        plog.info("AutoFetch", "IMAP IDLE disabled")
        return
    if _watcher_task and not _watcher_task.done():
        return

    async def _boot_and_pump() -> None:
        _stop.clear()
        loop = asyncio.get_running_loop()
        trigger = asyncio.Event()

        def _on_change() -> None:
            trigger.set()

        thread = threading.Thread(
            target=_idle_thread_main,
            args=(loop, _on_change),
            name="imap-idle-watcher",
            daemon=True,
        )
        thread.start()
        plog.info("AutoFetch", "IMAP IDLE watcher started", user=settings.EMAIL_USER, server=settings.IMAP_SERVER)

        while not _stop.is_set():
            await trigger.wait()
            trigger.clear()
            await asyncio.sleep(2.0)
            while trigger.is_set():
                trigger.clear()
                await asyncio.sleep(1.0)
            await run_phase1_exclusive(
                runner,
                notify_bus=notify_bus,
                source="imap_idle",
                wait=False,
            )

    _watcher_task = asyncio.create_task(_boot_and_pump(), name="imap-idle-boot")
    plog.info("AutoFetch", "IMAP IDLE connecting in background — HTTP API ready")


async def stop_imap_idle_watcher() -> None:
    global _watcher_task
    _stop.set()
    if _watcher_task:
        _watcher_task.cancel()
        try:
            await _watcher_task
        except asyncio.CancelledError:
            pass
        _watcher_task = None
    plog.info("AutoFetch", "IMAP IDLE watcher stopped")
