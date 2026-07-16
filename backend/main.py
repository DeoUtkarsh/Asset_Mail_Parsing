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
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

FILES_DIR = Path(__file__).resolve().parent / "attachment_files"

from config import settings
from database import supabase, get_supabase
from models import (
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
    run_parent_contact_extraction,
)
from agents.signature_extract import run_parent_signature_extraction
from agents.confidence_score import compute_attachment_confidence
from verification import set_attachment_verified
from vessel_library import (
    autofill_library,
    list_library,
    detect_new_vessels,
    add_library_vessel,
    update_library_vessel,
    delete_library_vessel,
)
from column_defs import (
    ensure_column_definitions,
    sync_column_definitions,
    migrate_all_vessel_rows,
    backfill_vessel_company_names,
    get_column_definitions,
    empty_standard_dynamic_data,
)

MANUAL_ENTRIES_MESSAGE_ID = "manual-entries"

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
            "level": "DEBUG",
        }
    },
    "root": {"handlers": ["console"], "level": "DEBUG"},
    # Quieten noisy third-party loggers
    "loggers": {
        "httpx":          {"level": "WARNING"},
        "httpcore":       {"level": "WARNING"},
        "watchfiles":     {"level": "WARNING"},
        "uvicorn.access": {"level": "INFO"},
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
    logger.info("  FILTER_SENDER    : %s", settings.FILTER_SENDER)
    logger.info("  NVIDIA_MODEL     : %s", settings.NVIDIA_LLM_MODEL)
    logger.info("  DB               : PostgreSQL %s:%s / %s",
                settings.PG_HOST, settings.PG_PORT, settings.PG_DATABASE)
    logger.info("  MAX_ATTACHMENTS  : %s",
                settings.MAX_ATTACHMENTS if settings.MAX_ATTACHMENTS > 0 else "ALL")
    logger.info("=" * 60)

    # Verify PostgreSQL is reachable at startup
    try:
        db = get_supabase()
        db.table("parent_emails").select("id").limit(1).execute()
        logger.info("  PostgreSQL connection: OK ✓")
        ensure_column_definitions(db)
        sync_column_definitions(db)
        migrated = migrate_all_vessel_rows(db)
        if migrated:
            logger.info("  Vessel data migration: %d rows updated to standard columns", migrated)
        companies = backfill_vessel_company_names(db)
        if companies:
            logger.info("  Vessel company backfill: %d rows updated", companies)
        if not (db.table("vessel_library").select("id").limit(1).execute().data):
            seeded = autofill_library(db)
            if seeded:
                logger.info("  Vessel library seeded: %d vessels", seeded)
    except Exception as exc:
        logger.error("  PostgreSQL connection FAILED: %s", exc)
        logger.error("  Check that pgAdmin is running and PG_* settings in .env are correct.")

    logger.info("=" * 60)


# ── Background runner ────────────────────────────────────────────────────────

async def _run_phase1(job_id: str) -> None:
    logger.info("[Phase1] Starting job_id=%s", job_id)
    initial_state = {
        "job_id": job_id,
        "email_id": "",
        "attachment_ids": [],
        "attachment_count": 0,
        "superset_columns": [],
        "error": "",
    }
    try:
        final_state = await phase1_graph.ainvoke(initial_state)
        if final_state.get("error"):
            logger.error("[Phase1] Failed: %s", final_state["error"])
            await sse_manager.send(job_id, "phase1_failed", {"error": final_state["error"]})
        else:
            email_id = final_state["email_id"]
            if email_id:
                try:
                    await run_parent_signature_extraction(job_id, email_id)
                    await run_parent_contact_extraction(job_id, email_id)
                    backfill_vessel_company_names(supabase)
                except Exception as sig_exc:
                    logger.exception("[Phase1] Signature/contact extraction failed: %s", sig_exc)
            logger.info("[Phase1] Complete — email_id=%s, columns=%d",
                        email_id, len(final_state.get("superset_columns", [])))
            await sse_manager.send(job_id, "phase1_complete", {
                "email_id": email_id,
                "columns": final_state.get("superset_columns", []),
            })
    except Exception as exc:
        logger.exception("[Phase1] Crashed: %s", exc)
        await sse_manager.send(job_id, "phase1_failed", {"error": str(exc)})


# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    try:
        get_supabase().table("parent_emails").select("id").limit(1).execute()
        db_status = "ok"
    except Exception as e:
        db_status = f"error: {e}"
    return {"status": "ok", "db": db_status}


@app.post("/api/fetch-emails")
async def fetch_emails(background_tasks: BackgroundTasks):
    logger.info("[API] POST /api/fetch-emails — starting Phase 1")
    job_id = str(uuid.uuid4())
    background_tasks.add_task(_run_phase1, job_id)
    return {"job_id": job_id, "message": "Phase 1 started. Connect to /api/events/{job_id} for updates."}


@app.get("/api/events/{job_id}")
async def sse_events(request: Request, job_id: str):
    logger.info("[SSE] Client connected — job_id=%s", job_id)
    queue = sse_manager.subscribe(job_id)

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

                    if parsed.get("type") in ("phase1_complete", "phase1_failed", "drafting_done", "phase2_failed"):
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
                    "is_verified, manually_reviewed, created_at, raw_text"
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
                )
                att_list.append({
                    k: v for k, v in att.items() if k != "raw_text"
                } | {
                    "is_verified": bool(att.get("is_verified")),
                    "manually_reviewed": bool(att.get("manually_reviewed")),
                    "vessel_count": vessel_count,
                    "retry_suggested": False,
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
            .select("id, dynamic_data, region, is_validated")
            .eq("attachment_id", att_id)
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
        path = FILES_DIR / att_id / entry.get("stored", "")
        if not path.is_file():
            raise HTTPException(status_code=404, detail="File missing on disk.")
        return FileResponse(
            path,
            media_type=entry.get("content_type") or "application/octet-stream",
            filename=entry.get("name") or path.name,
            content_disposition_type="inline",
        )
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
                "filename, signature_emails, signature_phones, status, is_verified, manually_reviewed"
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
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[API] get_raw_text failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


_VESSEL_GRID_COLUMNS = (
    "id, attachment_id, dynamic_data, region, is_validated, filename, "
    "parent_email_id, subject, date_received, signature_emails, signature_phones"
)


def _sort_vessel_rows(rows: list[dict]) -> list[dict]:
    """Oldest parent email first, then attachment filename."""
    return sorted(
        rows,
        key=lambda r: (
            str(r.get("date_received") or ""),
            str(r.get("filename") or ""),
        ),
    )


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
                update_payload[key] = val.strip()
        if not update_payload:
            raise HTTPException(status_code=400, detail="No fields to update.")
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
            out[key] = row.get(key) or ""
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
        update_payload: dict[str, Any] = {"dynamic_data": body.dynamic_data}
        if body.region is not None:
            update_payload["region"] = body.region
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
    """Re-run the auto-fill (idempotent — only inserts vessels not already present)."""
    logger.info("[API] POST /api/vessel-library/autofill")
    try:
        inserted = autofill_library(supabase)
        return {"inserted": inserted}
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
        att_id = _get_or_create_manual_attachment()
        dd = empty_standard_dynamic_data()
        for key, val in (body.dynamic_data or {}).items():
            if key in dd:
                dd[key] = str(val or "").strip()
        result = (
            supabase.table("vessels")
            .insert({
                "attachment_id": att_id,
                "dynamic_data": dd,
                "region": (body.region or "").strip(),
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
