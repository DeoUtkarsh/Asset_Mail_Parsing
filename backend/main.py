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
GET  /api/emails/{email_id}/vessels     → All vessels for one parent email
GET  /api/columns                     → Column definitions (id + header) from PostgreSQL
GET  /api/emails/{email_id}/columns     → Same column list (legacy path)
GET  /api/contacts                      → All attachments with parent email + signature contacts
PUT  /api/attachments/{att_id}/contacts → Update signature emails/phones for one attachment
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
from sse_starlette.sse import EventSourceResponse

from config import settings
from database import supabase, get_supabase
from models import (
    GenerateDraftRequest,
    UpdateVesselRequest,
    UpdateAttachmentContactsRequest,
    SetAttachmentVerifiedRequest,
)
from sse_manager import sse_manager
from workflow import phase2_graph
from agents.ingestion import run_batch_ingestion
from agents.extraction import run_extraction
from agents.normalization import run_normalization
from agents.signature_extract import run_parent_signature_extraction
from column_defs import (
    STANDARD_DYNAMIC_KEYS,
    ensure_column_definitions,
    sync_column_definitions,
    migrate_all_vessel_rows,
    get_column_definitions,
)
from verification import (
    set_attachment_verified,
    verify_all_eligible,
    assert_attachment_editable,
)

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
    logger.info("  EXTRACT_CONCURRENCY: %d", settings.EXTRACTION_CONCURRENCY)
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
    except Exception as exc:
        logger.error("  PostgreSQL connection FAILED: %s", exc)
        logger.error("  Check that pgAdmin is running and PG_* settings in .env are correct.")

    logger.info("=" * 60)


# ── Background runner ────────────────────────────────────────────────────────

async def _run_phase1(job_id: str) -> None:
    """Ingest all new parent emails first, then extract/normalize each one."""
    logger.info("[Phase1] Starting job_id=%s (all new inbox emails)", job_id)
    final_columns: list = []
    last_email_id = ""

    try:
        await sse_manager.send(job_id, "phase1_batch_started", {
            "message": "Scanning inbox for all new matching emails…",
        })

        ingested = await run_batch_ingestion(job_id)
        if not ingested:
            logger.info("[Phase1] No new emails to fetch")
            await sse_manager.send(job_id, "phase1_no_new", {
                "message": "No new forwarded emails to fetch. All matching mails are already in the database.",
            })
            return

        for idx, item in enumerate(ingested, start=1):
            email_id = item["email_id"]
            attachment_ids = item.get("attachment_ids") or []

            try:
                if attachment_ids:
                    await run_extraction(job_id, attachment_ids)
                    await run_parent_signature_extraction(job_id, email_id)
                cols = await run_normalization(job_id, email_id)
                if cols:
                    final_columns = cols
            except Exception as exc:
                logger.error("[Phase1] Failed on email_id=%s: %s", email_id, exc)
                await sse_manager.send(job_id, "phase1_failed", {"error": str(exc)})
                return

            last_email_id = email_id
            logger.info(
                "[Phase1] Parent email %d/%d complete — email_id=%s",
                idx,
                len(ingested),
                email_id,
            )
            await sse_manager.send(job_id, "parent_email_done", {
                "email_id": email_id,
                "index": idx,
                "total": len(ingested),
                "attachment_count": item.get("attachment_count", 0),
                "subject": item.get("subject", ""),
                "sender": item.get("sender", ""),
            })

        logger.info("[Phase1] Batch complete — %d parent email(s)", len(ingested))
        await sse_manager.send(job_id, "phase1_complete", {
            "email_id": last_email_id,
            "emails_processed": len(ingested),
            "columns": final_columns,
        })
    except Exception as exc:
        logger.exception("[Phase1] Crashed: %s", exc)
        await sse_manager.send(job_id, "phase1_failed", {"error": str(exc)})


async def _run_retry_extraction(job_id: str, email_id: str) -> None:
    from agents.extraction import get_retryable_attachment_ids, run_retry_extraction_for_email
    from agents.normalization import run_normalization
    from agents.signature_extract import run_parent_signature_extraction

    attachment_ids = get_retryable_attachment_ids(email_id)
    if not attachment_ids:
        logger.info("[Retry] No attachments to retry for email_id=%s", email_id)
        await sse_manager.send(job_id, "retry_no_work", {
            "message": "No failed or pending attachments to retry for this email.",
        })
        return

    logger.info("[Retry] Starting job_id=%s email_id=%s (%d attachments)",
                job_id, email_id, len(attachment_ids))
    await sse_manager.send(job_id, "retry_started", {
        "email_id": email_id,
        "attachment_count": len(attachment_ids),
        "message": f"Retrying {len(attachment_ids)} attachment(s)…",
    })

    try:
        await run_retry_extraction_for_email(job_id, email_id)
        await run_parent_signature_extraction(job_id, email_id)
        columns = await run_normalization(job_id, email_id)
        await sse_manager.send(job_id, "phase1_complete", {
            "email_id": email_id,
            "columns": columns,
        })
    except Exception as exc:
        logger.exception("[Retry] Failed: %s", exc)
        await sse_manager.send(job_id, "phase1_failed", {"error": str(exc)})


async def _run_single_attachment_retry(job_id: str, attachment_id: str) -> None:
    from agents.extraction import prepare_attachments_for_retry, run_extraction
    from agents.normalization import run_normalization
    from agents.signature_extract import run_attachment_signature_extraction

    row = (
        supabase.table("attachments")
        .select("id, parent_email_id, filename")
        .eq("id", attachment_id)
        .execute()
    )
    if not row.data:
        await sse_manager.send(job_id, "retry_no_work", {"message": "Attachment not found."})
        return
    att = row.data[0]
    email_id = att["parent_email_id"]
    filename = att.get("filename") or ""

    await sse_manager.send(job_id, "retry_started", {
        "email_id": email_id,
        "attachment_id": attachment_id,
        "filename": filename,
        "message": f"Retrying {filename}…",
    })

    try:
        prepare_attachments_for_retry([attachment_id])
        supabase.table("parent_emails").update({"status": "extracting"}).eq("id", email_id).execute()
        await run_extraction(job_id, [attachment_id])
        await run_attachment_signature_extraction(job_id, attachment_id)
        columns = await run_normalization(job_id, email_id)
        await sse_manager.send(job_id, "phase1_complete", {
            "email_id": email_id,
            "columns": columns,
        })
    except Exception as exc:
        logger.exception("[Retry] Single attachment failed: %s", exc)
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


@app.post("/api/emails/{email_id}/retry-extraction")
async def retry_extraction(email_id: str, background_tasks: BackgroundTasks):
    logger.info("[API] POST /api/emails/%s/retry-extraction", email_id)
    existing = (
        supabase.table("parent_emails")
        .select("id")
        .eq("id", email_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Email not found.")
    job_id = str(uuid.uuid4())
    background_tasks.add_task(_run_retry_extraction, job_id, email_id)
    return {
        "job_id": job_id,
        "message": "Retry started. Connect to /api/events/{job_id} for updates.",
    }


@app.post("/api/attachments/{att_id}/retry-extraction")
async def retry_attachment_extraction(att_id: str, background_tasks: BackgroundTasks):
    logger.info("[API] POST /api/attachments/%s/retry-extraction", att_id)
    row = (
        supabase.table("attachments")
        .select("id")
        .eq("id", att_id)
        .execute()
    )
    if not row.data:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    job_id = str(uuid.uuid4())
    background_tasks.add_task(_run_single_attachment_retry, job_id, att_id)
    return {
        "job_id": job_id,
        "message": "Attachment retry started. Connect to /api/events/{job_id} for updates.",
    }


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

                    if parsed.get("type") in (
                        "phase1_complete",
                        "phase1_failed",
                        "phase1_no_new",
                        "retry_no_work",
                        "drafting_done",
                        "phase2_failed",
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
            from agents.extraction import get_retryable_attachment_ids
            retry_ids = set(get_retryable_attachment_ids(em["id"]))
            atts = (
                supabase.table("attachments")
                .select("id, filename, status, error_message, is_verified, created_at")
                .eq("parent_email_id", em["id"])
                .order("created_at")
                .execute()
            )
            att_list = []
            for att in atts.data or []:
                vrows = (
                    supabase.table("vessels")
                    .select("id")
                    .eq("attachment_id", att["id"])
                    .execute()
                )
                att_list.append({
                    **att,
                    "is_verified": bool(att.get("is_verified")),
                    "vessel_count": len(vrows.data or []),
                    "retry_suggested": att["id"] in retry_ids,
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
            .order("created_at")
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


@app.get("/api/attachments/{att_id}/raw")
async def get_raw_text(att_id: str):
    logger.info("[API] GET /api/attachments/%s/raw", att_id)
    try:
        row = (
            supabase.table("attachments")
            .select(
                "raw_text, filename, signature_emails, signature_phones, status, is_verified",
            )
            .eq("id", att_id)
            .single()
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
        return {
            "raw_text": att.get("raw_text"),
            "filename": att.get("filename"),
            "signature_emails": att.get("signature_emails") or "",
            "signature_phones": att.get("signature_phones") or "",
            "status": att.get("status"),
            "is_verified": bool(att.get("is_verified")),
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
    """All vessels from parent emails that finished Phase 1 (validation-ready)."""
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


@app.get("/api/emails/{email_id}/vessels")
async def get_all_vessels(email_id: str):
    logger.info("[API] GET /api/emails/%s/vessels", email_id)
    try:
        rows = (
            supabase.table("vessels_full")
            .select(_VESSEL_GRID_COLUMNS)
            .eq("parent_email_id", email_id)
            .eq("attachment_is_verified", True)
            .execute()
        )
        data = _sort_vessel_rows(rows.data or [])
        logger.info("[API] Returning %d vessels", len(data))
        return data
    except Exception as exc:
        logger.error("[API] get_all_vessels failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/columns")
async def list_column_definitions():
    logger.info("[API] GET /api/columns")
    try:
        return {"columns": get_column_definitions(supabase)}
    except Exception as exc:
        logger.error("[API] list_column_definitions failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/emails/{email_id}/columns")
async def get_superset_columns(email_id: str):
    logger.info("[API] GET /api/emails/%s/columns", email_id)
    try:
        return {"columns": get_column_definitions(supabase)}
    except Exception as exc:
        logger.error("[API] get_superset_columns failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/contacts")
async def list_contacts():
    """Flat list: one row per attachment with parent email context and signature contacts."""
    logger.info("[API] GET /api/contacts")
    try:
        emails = (
            supabase.table("parent_emails")
            .select("id, subject, sender, date_received")
            .order("date_received", desc=True)
            .execute()
        )
        result = []
        for em in emails.data or []:
            atts = (
                supabase.table("attachments")
                .select("id, filename, signature_emails, signature_phones")
                .eq("parent_email_id", em["id"])
                .order("filename")
                .execute()
            )
            for att in atts.data or []:
                result.append({
                    "attachment_id": att["id"],
                    "filename": att.get("filename") or "",
                    "signature_emails": att.get("signature_emails") or "",
                    "signature_phones": att.get("signature_phones") or "",
                    "parent_email_id": em["id"],
                    "subject": em.get("subject") or "",
                    "sender": em.get("sender") or "",
                    "date_received": em.get("date_received"),
                })
        logger.info("[API] Returning %d contact rows", len(result))
        return result
    except Exception as exc:
        logger.error("[API] list_contacts failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/api/attachments/{att_id}/verified")
async def set_attachment_verified_route(att_id: str, body: SetAttachmentVerifiedRequest):
    logger.info("[API] PUT /api/attachments/%s/verified → %s", att_id, body.verified)
    try:
        result = set_attachment_verified(supabase, att_id, body.verified)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("[API] set_attachment_verified failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/attachments/verify-all")
async def verify_all_attachments():
    logger.info("[API] POST /api/attachments/verify-all")
    try:
        return verify_all_eligible(supabase, parent_email_id=None)
    except Exception as exc:
        logger.error("[API] verify_all_attachments failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/emails/{email_id}/verify-attachments")
async def verify_email_attachments(email_id: str):
    logger.info("[API] POST /api/emails/%s/verify-attachments", email_id)
    try:
        return verify_all_eligible(supabase, parent_email_id=email_id)
    except Exception as exc:
        logger.error("[API] verify_email_attachments failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/api/attachments/{att_id}/contacts")
async def update_attachment_contacts(att_id: str, body: UpdateAttachmentContactsRequest):
    logger.info("[API] PUT /api/attachments/%s/contacts", att_id)
    try:
        update_payload: dict[str, Any] = {}
        if body.signature_emails is not None:
            val = body.signature_emails.strip()
            update_payload["signature_emails"] = val or None
        if body.signature_phones is not None:
            val = body.signature_phones.strip()
            update_payload["signature_phones"] = val or None
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
        row = result.data[0]
        return {
            "attachment_id": att_id,
            "signature_emails": row.get("signature_emails") or "",
            "signature_phones": row.get("signature_phones") or "",
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[API] update_attachment_contacts failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/api/vessels/{vessel_id}")
async def update_vessel(vessel_id: str, body: UpdateVesselRequest):
    logger.info("[API] PUT /api/vessels/%s", vessel_id)
    try:
        try:
            assert_attachment_editable(supabase, vessel_id)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        update_payload: dict[str, Any] = {"dynamic_data": body.dynamic_data}
        if body.region is not None:
            update_payload["region"] = body.region
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
        try:
            assert_attachment_editable(supabase, vessel_id)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
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
            .select("id, filename, signature_emails, signature_phones")
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
                "dynamic_data": {k: "" for k in STANDARD_DYNAMIC_KEYS},
                "region": "",
                "is_validated": False,
            })
            .execute()
        )
        new_vessel = result.data[0]
        new_vessel["filename"] = att_row["filename"]
        new_vessel["signature_emails"] = att_row.get("signature_emails") or ""
        new_vessel["signature_phones"] = att_row.get("signature_phones") or ""
        logger.info("[API] Created blank vessel id=%s", new_vessel["id"])
        return new_vessel
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[API] create_vessel failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


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
