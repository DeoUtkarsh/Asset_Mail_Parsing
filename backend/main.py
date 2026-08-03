"""
FastAPI application — entry point.

Routes
------
POST /api/fetch-emails          → Trigger Phase 1 (returns immediately; SSE streams progress)
GET  /api/events/{job_id}       → SSE stream for real-time status updates
GET  /api/emails                → List all parent emails + their attachments
GET  /api/emails/{email_id}/attachments → List attachments for one email
GET  /api/attachments/{att_id}/vessels  → Vessels for one attachment (Preview Modal)
GET  /api/vessels                     → All vessels across ready parent emails (Validation Grid)
GET  /api/columns                     → Column definitions from PostgreSQL
GET  /api/emails/{email_id}/vessels     → All vessels for one parent email
GET  /api/emails/{email_id}/columns     → The superset column list for the grid
PUT  /api/vessels/{vessel_id}           → Update a single vessel row (cell edit)
DELETE /api/vessels/{vessel_id}         → Delete a vessel row
POST /api/generate-draft                → Trigger Phase 2 (returns draft text)
"""
import asyncio
import json
import logging
import logging.config
import uuid
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from sse_starlette.sse import EventSourceResponse

from config import settings
from database import supabase, get_supabase
from file_storage import read_bytes, uses_s3
from models import (
    FetchEmailsRequest,
    GenerateDraftRequest,
    SummaryScopeRequest,
    SetAttachmentVerifiedRequest,
    UpdateVesselRequest,
    UpdateBrokerContactRequest,
    UpdateAttachmentContactsRequest,
    VesselLibraryRequest,
    ManualVesselRequest,
)
from sse_manager import sse_manager
from workflow import phase1_graph, phase2_graph
from agents.summary import summarize_vessels, summarize_inbox, summarize_contacts, summarize_home
from agents.contact_extract import (
    CONTACT_FIELD_KEYS,
    contact_match_key,
    dedupe_broker_contacts,
    normalize_contact_status,
)
from agents.confidence_score import attachment_needs_review, compute_attachment_confidence
from verification import backfill_auto_verify, set_attachment_verified
from vessel_library import (
    autofill_library,
    list_library,
    detect_new_vessels,
    add_library_vessel,
    update_library_vessel,
    delete_library_vessel,
    normalize_library_formats,
    rematch_library,
)
from column_defs import (
    ensure_column_definitions,
    sync_column_definitions,
    migrate_all_vessel_rows,
    fix_imo_vessel_type_misplacement,
    backfill_vessel_company_names,
    get_column_definitions,
    empty_standard_dynamic_data,
)
from imap_idle_watcher import (
    run_phase1_exclusive,
    start_imap_idle_watcher,
    stop_imap_idle_watcher,
    get_active_phase1_job_id,
)

MANUAL_ENTRIES_MESSAGE_ID = "manual-entries"
LIVE_BUS_JOB_ID = "live"

# ── Logging setup ─────────────────────────────────────────────────────────────
logging.config.dictConfig({
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {
            "format": "%(asctime)s | %(levelname)-8s | %(name)-30s | %(message)s",
            "datefmt": "%H:%M:%S",
        }
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "verbose",
            "level": "INFO",
        }
    },
    "root": {"handlers": ["console"], "level": "INFO"},
    # Anthropic DEBUG dumps full prompts and looks like work is still running after Synced.
    "loggers": {
        "anthropic":      {"level": "WARNING"},
        "openai":         {"level": "WARNING"},
        "httpx":          {"level": "WARNING"},
        "httpcore":       {"level": "WARNING"},
        "watchfiles":     {"level": "WARNING"},
        "uvicorn.access": {"level": "INFO"},
        "sse_starlette":  {"level": "WARNING"},
    },
})

logger = logging.getLogger(__name__)


# ── App factory ──────────────────────────────────────────────────────────────

app = FastAPI(title="Shipbroking Email Parser API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    logger.info("=" * 60)
    logger.info("  Shipbroking Email Parser — startup")
    logger.info("=" * 60)
    logger.info("  EMAIL_USER       : %s", settings.EMAIL_USER)
    logger.info("  BLOCKED_SENDERS  : %s", ", ".join(settings.blocked_sender_patterns))
    logger.info("  CLAUDE_MODEL     : %s", settings.CLAUDE_MODEL)
    logger.info("  DB               : PostgreSQL %s:%s / %s",
                settings.PG_HOST, settings.PG_PORT, settings.PG_DATABASE)
    logger.info("  MAX_EMAILS/FETCH : %s",
                settings.MAX_ATTACHMENTS if settings.MAX_ATTACHMENTS > 0 else "ALL")
    logger.info(
        "  AUTO_FETCH_IDLE  : %s",
        "ON" if settings.AUTO_FETCH_IMAP_IDLE else "OFF",
    )
    if uses_s3():
        logger.info(
            "  FILE STORAGE     : S3 s3://%s/%s/",
            settings.ATTACHMENTS_S3_BUCKET,
            (settings.ATTACHMENTS_S3_PREFIX or "attachment_files").strip("/"),
        )
    else:
        logger.info("  FILE STORAGE     : local attachment_files/")
    logger.info("=" * 60)

    # Verify PostgreSQL is reachable at startup
    try:
        db = get_supabase()
        db.table("parent_emails").select("id").limit(1).execute()
        logger.info("  PostgreSQL connection: OK ✓")
        ensure_column_definitions(db)
        sync_column_definitions(db)
        from region_geo import ensure_trade_geo_seeded
        geo = ensure_trade_geo_seeded(db)
        if not geo.get("skipped"):
            logger.info(
                "  Trade geo seeded: %d regions, %d ports, %d aliases",
                geo.get("regions", 0),
                geo.get("ports", 0),
                geo.get("aliases", 0),
            )
        migrated = migrate_all_vessel_rows(db)
        if migrated:
            logger.info("  Vessel data migration: %d rows updated to standard columns", migrated)
        imo_fixed = fix_imo_vessel_type_misplacement(db)
        if imo_fixed:
            logger.info("  IMO/vessel_type fix: %d rows updated", imo_fixed)
        row_order_fixed = backfill_vessel_row_order(db)
        if row_order_fixed:
            logger.info("  Vessel row_order backfill: %d rows updated", row_order_fixed)
        companies = backfill_vessel_company_names(db)
        if companies:
            logger.info("  Vessel company backfill: %d rows updated", companies)
        # Do NOT autofill vessel_library here — new vessels stay in "Review & add"
        # until the user promotes them from the Vessel Libraries List.
        try:
            rematch = rematch_library(db)
            if rematch.get("merged") or rematch.get("updated"):
                logger.info(
                    "  Vessel library rematch: merged=%s updated_keys=%s",
                    rematch.get("merged", 0),
                    rematch.get("updated", 0),
                )
            fmt_n = normalize_library_formats(db)
            if fmt_n:
                logger.info("  Vessel library format normalize: %d rows", fmt_n)
        except Exception as lib_fmt_exc:
            logger.warning("  Vessel library format normalize skipped: %s", lib_fmt_exc)
        try:
            contact_dedupe = dedupe_broker_contacts(db)
            if contact_dedupe.get("merged") or contact_dedupe.get("updated"):
                logger.info(
                    "  Contact rematch: merged=%s updated_keys=%s",
                    contact_dedupe.get("merged", 0),
                    contact_dedupe.get("updated", 0),
                )
        except Exception as contact_dedupe_exc:
            logger.warning("  Contact rematch skipped: %s", contact_dedupe_exc)
        auto_verified = backfill_auto_verify(db)
        if auto_verified:
            logger.info("  Auto-verified %d high-confidence attachment(s)", auto_verified)
    except Exception as exc:
        logger.error("  PostgreSQL connection FAILED: %s", exc)
        logger.error("  Check that pgAdmin is running and PG_* settings in .env are correct.")

    async def _notify_auto_fetch(job_id: str, data: dict) -> None:
        await sse_manager.send(LIVE_BUS_JOB_ID, "auto_fetch_started", {
            "job_id": job_id,
            **data,
        })

    async def _idle_phase1(job_id: str) -> None:
        """IDLE: only messages newer than the UID watermark (never full-inbox backfill)."""
        from imap_client import get_inbox_max_uid
        from imap_uid_watermark import advance_watermark, get_watermark

        min_uid = get_watermark()
        try:
            await _run_phase1(job_id, None, None, min_uid=min_uid)
        finally:
            # Always advance past current inbox max so empty results still move forward.
            try:
                advance_watermark(await asyncio.to_thread(get_inbox_max_uid))
            except Exception as wm_exc:  # noqa: BLE001
                logger.warning("[AutoFetch] Could not advance UID watermark: %s", wm_exc)

    await start_imap_idle_watcher(_idle_phase1, _notify_auto_fetch)

    logger.info("=" * 60)


@app.on_event("shutdown")
async def shutdown_event():
    await stop_imap_idle_watcher()


# ── Background runner ────────────────────────────────────────────────────────

async def _run_phase1(
    job_id: str,
    date_from: str | None = None,
    date_to: str | None = None,
    min_uid: int | None = None,
) -> None:
    logger.info(
        "[Phase1] Starting job_id=%s date_from=%s date_to=%s min_uid=%s",
        job_id, date_from, date_to, min_uid,
    )
    initial_state = {
        "job_id": job_id,
        "email_ids": [],
        "attachment_ids": [],
        "attachment_count": 0,
        "superset_columns": [],
        "error": "",
        "date_from": date_from or "",
        "date_to": date_to or "",
        # -1 = unrestricted (manual). >=0 = IDLE UID watermark.
        "min_uid": -1 if min_uid is None else int(min_uid),
        "max_imap_uid": 0,
    }
    try:
        final_state = await phase1_graph.ainvoke(initial_state)
        if final_state.get("error"):
            logger.error("[Phase1] Failed: %s", final_state["error"])
            await sse_manager.send(job_id, "phase1_failed", {"error": final_state["error"]})
            return

        email_ids = final_state.get("email_ids", []) or []

        # Persist active fetch window so Home AI summary scopes to it.
        # IDLE auto-fetch passes no dates — leave the existing Home scope alone.
        try:
            from fetch_scope import save_fetch_scope
            if date_from or date_to:
                scoped_ids = _email_ids_in_date_window(date_from, date_to)
                save_fetch_scope(
                    date_from=date_from,
                    date_to=date_to,
                    email_ids=scoped_ids or email_ids,
                )
        except Exception as scope_exc:  # noqa: BLE001
            logger.warning("[Phase1] Could not save fetch scope: %s", scope_exc)

        if not email_ids:
            logger.info("[Phase1] No new emails to process.")
            await sse_manager.send(job_id, "phase1_no_new", {
                "message": "No new broker emails found.",
                "date_from": date_from,
                "date_to": date_to,
            })
            return

        # Graph already did vessels + contacts + email_ready. Signal UI done now.
        logger.info("[Phase1] Complete — %d email(s), columns=%d",
                    len(email_ids), len(final_state.get("superset_columns", [])))
        await sse_manager.send(job_id, "phase1_complete", {
            "email_id": email_ids[0],
            "email_ids": email_ids,
            "email_count": len(email_ids),
            "columns": final_state.get("superset_columns", []),
            "date_from": date_from,
            "date_to": date_to,
        })

        try:
            backfill_vessel_company_names(supabase)
        except Exception as bf_exc:
            logger.exception("[Phase1] Company backfill failed: %s", bf_exc)

        try:
            pending = detect_new_vessels(supabase)
            logger.info("[Phase1] Vessel library review queue: %d new vessel(s)", len(pending))
        except Exception as lib_exc:
            logger.exception("[Phase1] Vessel library review detect failed: %s", lib_exc)
    except Exception as exc:
        logger.exception("[Phase1] Crashed: %s", exc)
        await sse_manager.send(job_id, "phase1_failed", {"error": str(exc)})


def _email_ids_in_date_window(date_from: str | None, date_to: str | None) -> list[str]:
    """Return parent_email ids whose date_received falls in [date_from, date_to] (inclusive)."""
    from datetime import datetime, timezone

    rows = (
        supabase.table("parent_emails")
        .select("id, date_received, message_id")
        .execute()
    ).data or []

    def _day(raw: str | None):
        if not raw:
            return None
        try:
            s = str(raw).replace("Z", "+00:00")
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.date()
        except ValueError:
            try:
                return datetime.strptime(str(raw)[:10], "%Y-%m-%d").date()
            except ValueError:
                return None

    df = None
    dt = None
    try:
        if date_from:
            df = datetime.strptime(date_from[:10], "%Y-%m-%d").date()
        if date_to:
            dt = datetime.strptime(date_to[:10], "%Y-%m-%d").date()
    except ValueError:
        return []

    out: list[str] = []
    for r in rows:
        if r.get("message_id") == "manual-entries":
            continue
        d = _day(r.get("date_received"))
        if d is None:
            continue
        if df and d < df:
            continue
        if dt and d > dt:
            continue
        out.append(r["id"])
    return out


# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    try:
        get_supabase().table("parent_emails").select("id").limit(1).execute()
        db_status = "ok"
    except Exception as e:
        db_status = f"error: {e}"
    return {
        "status": "ok",
        "db": db_status,
        "auto_fetch_imap_idle": bool(settings.AUTO_FETCH_IMAP_IDLE),
    }


@app.get("/api/runtime-config")
async def runtime_config():
    """UI flags for the current deployment (no secrets)."""
    return {
        "auto_fetch_imap_idle": bool(settings.AUTO_FETCH_IMAP_IDLE),
        # Lets the inbox attach mid-flight if it missed auto_fetch_started.
        "active_phase1_job_id": get_active_phase1_job_id(),
    }


@app.post("/api/fetch-emails")
async def fetch_emails(background_tasks: BackgroundTasks, body: FetchEmailsRequest | None = None):
    date_from = (body.date_from if body else None) or None
    date_to = (body.date_to if body else None) or None
    if date_from:
        date_from = date_from.strip()[:10] or None
    if date_to:
        date_to = date_to.strip()[:10] or None
    logger.info(
        "[API] POST /api/fetch-emails — starting Phase 1 date_from=%s date_to=%s",
        date_from, date_to,
    )
    job_id = str(uuid.uuid4())

    async def _runner(jid: str) -> None:
        await _run_phase1(jid, date_from, date_to)

    async def _locked() -> None:
        await run_phase1_exclusive(_runner, job_id=job_id, source="manual")

    background_tasks.add_task(_locked)
    return {
        "job_id": job_id,
        "message": "Phase 1 started. Connect to /api/events/{job_id} for updates.",
        "date_from": date_from,
        "date_to": date_to,
    }

@app.get("/api/events/{job_id}")
async def sse_events(request: Request, job_id: str):
    logger.info("[SSE] Client connected — job_id=%s", job_id)
    queue = sse_manager.subscribe(job_id)
    # Persistent bus for auto-fetch notifications (never closes on Phase-1 terminal).
    is_live_bus = job_id == LIVE_BUS_JOB_ID

    # Late joiners (tab refresh / SSE reconnect): if Phase-1 is already running,
    # push auto_fetch_started so the inbox can attach to the real job stream.
    if is_live_bus:
        active = get_active_phase1_job_id()
        if active:
            resume = json.dumps({
                "type": "auto_fetch_started",
                "job_id": active,
                "source": "resume",
            })
            queue.put_nowait(resume)

    async def generator():
        try:
            while True:
                if await request.is_disconnected():
                    logger.info("[SSE] Client disconnected — job_id=%s", job_id)
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                    parsed = json.loads(payload)
                    logger.debug("[SSE] Sending event type=%s job_id=%s", parsed.get("type"), job_id)
                    yield {"data": payload}

                    if (
                        not is_live_bus
                        and parsed.get("type") in (
                            "phase1_complete",
                            "phase1_failed",
                            "drafting_done",
                            "phase2_failed",
                        )
                    ):
                        logger.info("[SSE] Terminal event — closing stream job_id=%s", job_id)
                        break

                except asyncio.TimeoutError:
                    yield {"event": "heartbeat", "data": "ping"}
        finally:
            sse_manager.unsubscribe(job_id, queue)

    return EventSourceResponse(generator())


@app.get("/api/emails")
async def list_emails():
    logger.info("[API] GET /api/emails")
    try:
        emails = supabase.table("parent_emails").select("*").order("date_received", desc=True).execute()
        result = []
        for em in emails.data or []:
            if em.get("message_id") == MANUAL_ENTRIES_MESSAGE_ID:
                continue  # synthetic holder for manually-added positions
            atts = (
                supabase.table("attachments")
                .select(
                    "id, filename, status, error_message, mail_from, mail_subject, mail_date, files, "
                    "is_verified, manually_reviewed, created_at, raw_text, columns_in_email"
                )
                .eq("parent_email_id", em["id"])
                .order("created_at")
                .execute()
            )
            att_rows = atts.data or []
            att_ids = [a["id"] for a in att_rows]
            vessels_by_att: dict[str, list] = {aid: [] for aid in att_ids}
            if att_ids:
                vall = (
                    supabase.table("vessels")
                    .select("id, attachment_id, dynamic_data, region")
                    .in_("attachment_id", att_ids)
                    .execute()
                )
                for v in vall.data or []:
                    aid = v.get("attachment_id")
                    if aid in vessels_by_att:
                        vessels_by_att[aid].append(v)

            att_list = []
            for att in att_rows:
                aid = att["id"]
                vlist = vessels_by_att.get(aid, [])
                vessel_count = len(vlist)
                conf = compute_attachment_confidence(
                    status=att.get("status") or "",
                    vessel_count=vessel_count,
                    vessels=vlist,
                    raw_text=att.get("raw_text"),
                    retry_suggested=False,
                    manually_reviewed=bool(att.get("manually_reviewed")),
                    columns_in_email=att.get("columns_in_email"),
                )
                att_list.append({
                    k: v for k, v in att.items() if k != "raw_text"
                } | {
                    "is_verified": bool(att.get("is_verified")),
                    "manually_reviewed": bool(att.get("manually_reviewed")),
                    "vessel_count": vessel_count,
                    "retry_suggested": False,
                    "columns_in_email": conf.get("applicable_columns") or [],
                    "needs_review": attachment_needs_review(
                        status=att.get("status") or "",
                        confidence_tier=conf.get("confidence_tier"),
                        max_unfilled=conf.get("max_unfilled") or 0,
                    ),
                    **conf,
                })
            att_list.sort(key=lambda a: (str(a.get("created_at") or ""), (a.get("filename") or "").lower()))
            result.append({**em, "attachments": att_list})
        logger.info("[API] Returning %d emails", len(result))
        return result
    except Exception as exc:
        logger.error("[API] GET /api/emails failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/emails/{email_id}/attachments")
async def get_attachments(email_id: str):
    logger.info("[API] GET /api/emails/%s/attachments", email_id)
    try:
        rows = (
            supabase.table("attachments")
            .select("id, filename, status, error_message, raw_text")
            .eq("parent_email_id", email_id)
            .execute()
        )
        return rows.data or []
    except Exception as exc:
        logger.error("[API] get_attachments failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/attachments/{att_id}/vessels")
async def get_vessels_for_attachment(att_id: str):
    logger.info("[API] GET /api/attachments/%s/vessels", att_id)
    try:
        rows = (
            supabase.table("vessels")
            .select("id, dynamic_data, region, is_validated, row_order, created_at")
            .eq("attachment_id", att_id)
            .order("row_order")
            .execute()
        )
        return rows.data or []
    except Exception as exc:
        logger.error("[API] get_vessels_for_attachment failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/attachments/{att_id}/files/{idx}")
async def get_attachment_file(att_id: str, idx: int):
    """Serve a single stored file attachment (PDF/image/xlsx…) of an email."""
    try:
        row = supabase.table("attachments").select("files").eq("id", att_id).limit(1).execute()
        if not row.data:
            raise HTTPException(status_code=404, detail="Attachment not found.")
        files = row.data[0].get("files") or []
        entry = next((f for f in files if f.get("idx") == idx), None)
        if not entry:
            raise HTTPException(status_code=404, detail="File not found.")
        stored = entry.get("stored") or ""
        try:
            content = read_bytes(att_id, stored)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="File missing in storage.")
        filename = entry.get("name") or stored or "file"
        media = entry.get("content_type") or "application/octet-stream"
        # inline so images/PDFs open in the preview pane
        headers = {"Content-Disposition": f'inline; filename="{filename}"'}
        return Response(content=content, media_type=media, headers=headers)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[API] get_attachment_file failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/attachments/{att_id}/raw")
async def get_raw_text(att_id: str):
    logger.info("[API] GET /api/attachments/%s/raw", att_id)
    try:
        row = (
            supabase.table("attachments")
            .select(
                "raw_text, preview_html, preview_plain, preview_images, "
                "filename, signature_emails, signature_phones, status, is_verified, manually_reviewed, files"
            )
            .eq("id", att_id)
            .limit(1)
            .execute()
        )
        if not row.data:
            raise HTTPException(status_code=404, detail="Attachment not found.")
        att = row.data[0]
        vrows = (
            supabase.table("vessels")
            .select("id")
            .eq("attachment_id", att_id)
            .execute()
        )
        preview_images = att.get("preview_images")
        if isinstance(preview_images, str):
            try:
                preview_images = json.loads(preview_images)
            except json.JSONDecodeError:
                preview_images = None
        preview_mode = "fallback"
        if att.get("preview_html"):
            preview_mode = "html"
            if preview_images:
                preview_mode = "html_images"
        elif preview_images:
            preview_mode = "images"
        elif att.get("preview_plain"):
            preview_mode = "plain"
        return {
            "raw_text": att.get("raw_text"),
            "preview_html": att.get("preview_html"),
            "preview_plain": att.get("preview_plain"),
            "preview_images": preview_images,
            "preview_mode": preview_mode,
            "filename": att.get("filename"),
            "signature_emails": att.get("signature_emails") or "",
            "signature_phones": att.get("signature_phones") or "",
            "status": att.get("status"),
            "is_verified": bool(att.get("is_verified")),
            "manually_reviewed": bool(att.get("manually_reviewed")),
            "vessel_count": len(vrows.data or []),
            "files": att.get("files") or [],
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[API] get_raw_text failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


_VESSEL_GRID_COLUMNS = (
    "id, attachment_id, dynamic_data, region, is_validated, row_order, created_at, filename, "
    "parent_email_id, subject, date_received, signature_emails, signature_phones, "
    "attachment_files"
)


def _sort_vessel_rows(rows: list[dict]) -> list[dict]:
    """Email date → attachment → source row order (matches original mail listing)."""
    return sorted(
        rows,
        key=lambda r: (
            str(r.get("date_received") or ""),
            str(r.get("filename") or "").lower(),
            r.get("row_order") if r.get("row_order") is not None else 0,
            str(r.get("created_at") or ""),
        ),
    )


def backfill_vessel_row_order(supabase) -> int:
    """Assign row_order from created_at for rows extracted before ordering was stored."""
    rows = supabase.table("vessels").select("id, attachment_id, created_at, row_order").execute()
    by_att: dict[str, list[dict]] = {}
    for row in rows.data or []:
        aid = row.get("attachment_id")
        if aid:
            by_att.setdefault(aid, []).append(row)
    updated = 0
    for vessels in by_att.values():
        vessels.sort(key=lambda v: str(v.get("created_at") or ""))
        for idx, v in enumerate(vessels):
            if (v.get("row_order") or 0) != idx:
                supabase.table("vessels").update({"row_order": idx}).eq("id", v["id"]).execute()
                updated += 1
    if updated:
        logger.info("Backfilled row_order on %d vessel rows", updated)
    return updated


@app.get("/api/vessels")
async def list_all_vessels():
    """All vessels from parent emails that finished Phase 1."""
    logger.info("[API] GET /api/vessels")
    try:
        ready = (
            supabase.table("parent_emails")
            .select("id")
            .in_("status", ["ready_for_validation", "drafted"])
            .execute()
        )
        email_ids = [e["id"] for e in (ready.data or [])]
        if not email_ids:
            return []
        rows = (
            supabase.table("vessels_full")
            .select(_VESSEL_GRID_COLUMNS)
            .in_("parent_email_id", email_ids)
            .eq("attachment_is_verified", True)
            .execute()
        )
        data = _sort_vessel_rows(rows.data or [])
        logger.info("[API] Returning %d vessels from %d emails", len(data), len(email_ids))
        return data
    except Exception as exc:
        logger.error("[API] list_all_vessels failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/columns")
async def list_column_definitions():
    logger.info("[API] GET /api/columns")
    try:
        return {"columns": get_column_definitions(supabase)}
    except Exception as exc:
        logger.error("[API] list_column_definitions failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/emails/{email_id}/vessels")
async def get_all_vessels(email_id: str):
    logger.info("[API] GET /api/emails/%s/vessels", email_id)
    try:
        rows = (
            supabase.table("vessels_full")
            .select(_VESSEL_GRID_COLUMNS)
            .eq("parent_email_id", email_id)
            .execute()
        )
        data = _sort_vessel_rows(rows.data or [])
        logger.info("[API] Returning %d vessels", len(data))
        return data
    except Exception as exc:
        logger.error("[API] get_all_vessels failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/emails/{email_id}/columns")
async def get_superset_columns(email_id: str):
    logger.info("[API] GET /api/emails/%s/columns", email_id)
    try:
        rows = (
            supabase.table("vessels_full")
            .select("dynamic_data")
            .eq("parent_email_id", email_id)
            .execute()
        )
        return {"columns": get_column_definitions(supabase)}
    except Exception as exc:
        logger.error("[API] get_superset_columns failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/home/summary")
async def home_summary():
    """Home dashboard: pipeline counts (SQL) + short AI narrative."""
    logger.info("[API] GET /api/home/summary")
    try:
        return await summarize_home()
    except Exception as exc:
        logger.error("[API] home_summary failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/summary/inbox")
async def summary_inbox(body: SummaryScopeRequest | None = None):
    """Fresh AI summary for Email Extraction Inbox (optional email_ids = current page)."""
    logger.info("[API] POST /api/summary/inbox")
    try:
        ids = body.email_ids if body else None
        return await summarize_inbox(ids)
    except Exception as exc:
        logger.error("[API] summary_inbox failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/summary/vessels")
async def summary_vessels(body: SummaryScopeRequest | None = None):
    """Fresh AI summary for Vessel Position List (optional vessel_ids = selection)."""
    logger.info("[API] POST /api/summary/vessels")
    try:
        ids = body.vessel_ids if body else None
        return await summarize_vessels(ids)
    except Exception as exc:
        logger.error("[API] summary_vessels failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/contacts")
async def list_contacts():
    """Flat list: one row per broker contact with parent email + attachment context."""
    logger.info("[API] GET /api/contacts")
    try:
        contact_rows = (
            supabase.table("broker_contacts")
            .select(
                "id, attachment_id, parent_email_id, row_order, used_fallback, "
                + ", ".join(CONTACT_FIELD_KEYS)
            )
            .order("row_order")
            .execute()
        ).data or []

        parents = {
            p["id"]: p
            for p in (
                supabase.table("parent_emails")
                .select("id, subject, sender, date_received")
                .execute()
            ).data
            or []
        }
        attachments = {
            a["id"]: a
            for a in (
                supabase.table("attachments")
                .select("id, filename")
                .execute()
            ).data
            or []
        }

        result = []
        for row in contact_rows:
            parent = parents.get(row.get("parent_email_id") or "", {})
            att = attachments.get(row.get("attachment_id") or "", {})
            item = {
                "contact_id": row["id"],
                "attachment_id": row.get("attachment_id") or "",
                "filename": att.get("filename") or "",
                "parent_email_id": row.get("parent_email_id") or "",
                "subject": parent.get("subject") or "",
                "sender": parent.get("sender") or "",
                "date_received": parent.get("date_received"),
                "used_fallback": bool(row.get("used_fallback")),
                "row_order": row.get("row_order") or 0,
            }
            for key in CONTACT_FIELD_KEYS:
                if key == "status":
                    item[key] = normalize_contact_status(row.get(key))
                else:
                    item[key] = row.get(key) or ""
            result.append(item)

        result.sort(
            key=lambda r: (
                r.get("date_received") or "",
                r.get("filename") or "",
                r.get("row_order") or 0,
            ),
            reverse=True,
        )
        logger.info("[API] Returning %d broker contact rows", len(result))
        return result
    except Exception as exc:
        logger.error("[API] list_contacts failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/api/contacts/{contact_id}")
async def update_broker_contact(contact_id: str, body: UpdateBrokerContactRequest):
    logger.info("[API] PUT /api/contacts/%s", contact_id)
    try:
        from datetime import datetime, timezone

        update_payload: dict[str, Any] = {}
        for key in CONTACT_FIELD_KEYS:
            val = getattr(body, key, None)
            if val is not None:
                update_payload[key] = (
                    normalize_contact_status(val) if key == "status" else val.strip()
                )
        if not update_payload:
            raise HTTPException(status_code=400, detail="No fields to update.")

        existing = (
            supabase.table("broker_contacts")
            .select("id, match_key, " + ", ".join(CONTACT_FIELD_KEYS))
            .eq("id", contact_id)
            .limit(1)
            .execute()
        ).data or []
        if not existing:
            raise HTTPException(status_code=404, detail="Contact not found.")
        merged_for_key = {**existing[0], **update_payload}
        new_key = contact_match_key(merged_for_key)
        if new_key:
            # If identity now collides with another row, merge into that row
            clash = (
                supabase.table("broker_contacts")
                .select("id, " + ", ".join(CONTACT_FIELD_KEYS))
                .eq("match_key", new_key)
                .neq("id", contact_id)
                .limit(1)
                .execute()
            ).data or []
            if clash:
                from agents.contact_extract import _merge_contact_fields

                survivor = clash[0]
                merged = _merge_contact_fields(survivor, merged_for_key)
                merged["match_key"] = new_key
                merged["updated_at"] = datetime.now(timezone.utc).isoformat()
                result = (
                    supabase.table("broker_contacts")
                    .update(merged)
                    .eq("id", survivor["id"])
                    .execute()
                )
                supabase.table("broker_contacts").delete().eq("id", contact_id).execute()
                row = result.data[0] if result.data else {**survivor, **merged}
            else:
                update_payload["match_key"] = new_key
                update_payload["updated_at"] = datetime.now(timezone.utc).isoformat()
                result = (
                    supabase.table("broker_contacts")
                    .update(update_payload)
                    .eq("id", contact_id)
                    .execute()
                )
                if not result.data:
                    raise HTTPException(status_code=404, detail="Contact not found.")
                row = result.data[0]
        else:
            update_payload["updated_at"] = datetime.now(timezone.utc).isoformat()
            result = (
                supabase.table("broker_contacts")
                .update(update_payload)
                .eq("id", contact_id)
                .execute()
            )
            if not result.data:
                raise HTTPException(status_code=404, detail="Contact not found.")
            row = result.data[0]

        att = (
            supabase.table("attachments")
            .select("filename")
            .eq("id", row.get("attachment_id") or "")
            .execute()
        ).data
        parent = (
            supabase.table("parent_emails")
            .select("subject, sender, date_received")
            .eq("id", row.get("parent_email_id") or "")
            .execute()
        ).data
        att_row = att[0] if att else {}
        parent_row = parent[0] if parent else {}
        out = {
            "contact_id": row["id"],
            "attachment_id": row.get("attachment_id") or "",
            "filename": att_row.get("filename") or "",
            "parent_email_id": row.get("parent_email_id") or "",
            "subject": parent_row.get("subject") or "",
            "sender": parent_row.get("sender") or "",
            "date_received": parent_row.get("date_received"),
            "used_fallback": bool(row.get("used_fallback")),
            "row_order": row.get("row_order") or 0,
        }
        for key in CONTACT_FIELD_KEYS:
            out[key] = (
                normalize_contact_status(row.get(key))
                if key == "status"
                else (row.get(key) or "")
            )
        return out
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[API] update_broker_contact failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/api/attachments/{att_id}/contacts")
async def update_attachment_contacts(att_id: str, body: UpdateAttachmentContactsRequest):
    logger.info("[API] PUT /api/attachments/%s/contacts", att_id)
    try:
        update_payload: dict[str, Any] = {}
        if body.signature_emails is not None:
            update_payload["signature_emails"] = body.signature_emails.strip() or None
        if body.signature_phones is not None:
            update_payload["signature_phones"] = body.signature_phones.strip() or None
        if not update_payload:
            raise HTTPException(status_code=400, detail="No fields to update.")
        result = (
            supabase.table("attachments")
            .update(update_payload)
            .eq("id", att_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Attachment not found.")
        return result.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[API] update_attachment_contacts failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/summary/contacts")
async def summary_contacts(body: SummaryScopeRequest | None = None):
    """Fresh AI summary for Contact List tab."""
    logger.info("[API] POST /api/summary/contacts")
    try:
        ids = body.contact_ids if body else None
        return await summarize_contacts(ids)
    except Exception as exc:
        logger.error("[API] summary_contacts failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.put("/api/attachments/{att_id}/verified")
async def set_attachment_verified_route(att_id: str, body: SetAttachmentVerifiedRequest):
    logger.info("[API] PUT /api/attachments/%s/verified → %s", att_id, body.verified)
    try:
        return set_attachment_verified(supabase, att_id, body.verified)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("[API] set_attachment_verified failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/api/vessels/{vessel_id}")
async def update_vessel(vessel_id: str, body: UpdateVesselRequest):
    logger.info("[API] PUT /api/vessels/%s", vessel_id)
    try:
        from column_defs import map_raw_to_standard

        # Re-canonicalize dynamic_data and derive standard region from open_location
        # so edits + Fetch Emails stay consistent.
        standardized, reg = map_raw_to_standard(body.dynamic_data or {}, body.region)
        update_payload: dict[str, Any] = {"dynamic_data": standardized, "region": reg}
        if body.is_validated is not None:
            update_payload["is_validated"] = body.is_validated
        result = (
            supabase.table("vessels")
            .update(update_payload)
            .eq("id", vessel_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Vessel not found.")
        return result.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[API] update_vessel failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.delete("/api/vessels/{vessel_id}")
async def delete_vessel(vessel_id: str):
    logger.info("[API] DELETE /api/vessels/%s", vessel_id)
    try:
        supabase.table("vessels").delete().eq("id", vessel_id).execute()
        return {"deleted": vessel_id}
    except Exception as exc:
        logger.error("[API] delete_vessel failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/emails/{email_id}/vessels")
async def create_vessel(email_id: str):
    """Create a blank vessel row for manual entry, attached to the first attachment of this email."""
    logger.info("[API] POST /api/emails/%s/vessels (manual create)", email_id)
    try:
        # Find the first attachment that belongs to this email
        att = (
            supabase.table("attachments")
            .select("id, filename")
            .eq("parent_email_id", email_id)
            .limit(1)
            .execute()
        )
        if not att.data:
            raise HTTPException(status_code=404, detail="No attachments found for this email. Fetch emails first.")
        att_row = att.data[0]
        result = (
            supabase.table("vessels")
            .insert({
                "attachment_id": att_row["id"],
                "dynamic_data": {},
                "region": "",
                "is_validated": False,
            })
            .execute()
        )
        new_vessel = result.data[0]
        # Return with filename so the grid can show the group header immediately
        new_vessel["filename"] = att_row["filename"]
        logger.info("[API] Created blank vessel id=%s", new_vessel["id"])
        return new_vessel
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[API] create_vessel failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/vessel-library")
async def get_vessel_library():
    """Vessel Library master list + vessels newly detected in position data."""
    logger.info("[API] GET /api/vessel-library")
    try:
        return {
            "vessels": list_library(supabase),
            "new_vessels": detect_new_vessels(supabase),
        }
    except Exception as exc:
        logger.error("[API] get_vessel_library failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/vessel-library")
async def create_vessel_library(body: VesselLibraryRequest):
    """Add a vessel (manual entry or promotion from the review list)."""
    logger.info("[API] POST /api/vessel-library — %s", body.vessel_name)
    try:
        return add_library_vessel(supabase, body.model_dump())
    except Exception as exc:
        logger.error("[API] create_vessel_library failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.put("/api/vessel-library/{vessel_id}")
async def edit_vessel_library(vessel_id: str, body: VesselLibraryRequest):
    logger.info("[API] PUT /api/vessel-library/%s", vessel_id)
    try:
        return update_library_vessel(supabase, vessel_id, body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("[API] edit_vessel_library failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.delete("/api/vessel-library/{vessel_id}")
async def remove_vessel_library(vessel_id: str):
    logger.info("[API] DELETE /api/vessel-library/%s", vessel_id)
    try:
        delete_library_vessel(supabase, vessel_id)
        return {"deleted": vessel_id}
    except Exception as exc:
        logger.error("[API] remove_vessel_library failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/vessel-library/autofill")
async def autofill_vessel_library():
    """Re-run library sync (insert new + fill blank fields on existing)."""
    logger.info("[API] POST /api/vessel-library/autofill")
    try:
        stats = autofill_library(supabase)
        return stats
    except Exception as exc:
        logger.error("[API] autofill_vessel_library failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _get_or_create_manual_attachment() -> str:
    """A single verified 'Manual entries' attachment that holds manually-added positions."""
    parent = (
        supabase.table("parent_emails")
        .select("id")
        .eq("message_id", MANUAL_ENTRIES_MESSAGE_ID)
        .limit(1)
        .execute()
    )
    if parent.data:
        parent_id = parent.data[0]["id"]
    else:
        parent_id = (
            supabase.table("parent_emails")
            .insert({
                "subject": "Manual entries",
                "sender": "Manual entry",
                "status": "ready_for_validation",
                "message_id": MANUAL_ENTRIES_MESSAGE_ID,
            })
            .execute()
        ).data[0]["id"]

    att = (
        supabase.table("attachments")
        .select("id")
        .eq("parent_email_id", parent_id)
        .limit(1)
        .execute()
    )
    if att.data:
        return att.data[0]["id"]
    return (
        supabase.table("attachments")
        .insert({
            "parent_email_id": parent_id,
            "filename": "Manual entries",
            "status": "done",
            "is_verified": True,
        })
        .execute()
    ).data[0]["id"]


@app.post("/api/vessels/manual")
async def create_manual_vessel(body: ManualVesselRequest):
    """Add a position row manually — appears in the Vessel Position List immediately."""
    logger.info("[API] POST /api/vessels/manual")
    try:
        from column_defs import map_raw_to_standard

        att_id = _get_or_create_manual_attachment()
        dd = empty_standard_dynamic_data()
        for key, val in (body.dynamic_data or {}).items():
            if key in dd:
                dd[key] = str(val or "").strip()
        standardized, reg = map_raw_to_standard(dd, body.region)
        result = (
            supabase.table("vessels")
            .insert({
                "attachment_id": att_id,
                "dynamic_data": standardized,
                "region": reg,
                "is_validated": True,
            })
            .execute()
        )
        new_vessel = result.data[0]
        new_vessel["filename"] = "Manual entries"
        return new_vessel
    except Exception as exc:
        logger.error("[API] create_manual_vessel failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/generate-draft")
async def generate_draft(body: GenerateDraftRequest, background_tasks: BackgroundTasks):
    logger.info("[API] POST /api/generate-draft — email_id=%s vessels=%d",
                body.email_id, len(body.vessels))
    job_id = str(uuid.uuid4())

    async def _run_phase2():
        logger.info("[Phase2] Starting job_id=%s, vessels=%d", job_id, len(body.vessels))
        initial_state = {
            "job_id": job_id,
            "email_id": body.email_id,
            "vessels": body.vessels,
            "columns": body.columns,
            "grid_columns": body.grid_columns or [],
            "draft_html": "",
            "zones": [],
            "error": "",
        }
        try:
            final_state = await phase2_graph.ainvoke(initial_state)
            if final_state.get("error"):
                logger.error("[Phase2] Failed: %s", final_state["error"])
                await sse_manager.send(job_id, "phase2_failed", {"error": final_state["error"]})
            else:
                logger.info(
                    "[Phase2] Done — %d zones, %d chars HTML",
                    len(final_state.get("zones", [])),
                    len(final_state.get("draft_html", "")),
                )
                await sse_manager.send(job_id, "drafting_done", {
                    "email_id": body.email_id,
                    "draft_html": final_state.get("draft_html", ""),
                    "zones": final_state.get("zones", []),
                })
        except Exception as exc:
            logger.exception("[Phase2] Crashed: %s", exc)
            await sse_manager.send(job_id, "phase2_failed", {"error": str(exc)})

    background_tasks.add_task(_run_phase2)
    return {"job_id": job_id, "message": "Phase 2 started."}
