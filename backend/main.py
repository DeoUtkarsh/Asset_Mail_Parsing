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
from sse_starlette.sse import EventSourceResponse

from config import settings
from database import supabase, get_supabase
from models import GenerateDraftRequest, UpdateVesselRequest
from sse_manager import sse_manager
from workflow import phase1_graph, phase2_graph

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
        elif not final_state.get("email_id"):
            logger.info("[Phase1] No new emails to fetch")
            await sse_manager.send(job_id, "phase1_no_new", {
                "message": "No new forwarded emails to fetch. All matching mails are already in the database.",
            })
        else:
            logger.info("[Phase1] Complete — email_id=%s, columns=%d",
                        final_state["email_id"], len(final_state.get("superset_columns", [])))
            await sse_manager.send(job_id, "phase1_complete", {
                "email_id": final_state["email_id"],
                "columns": final_state.get("superset_columns", []),
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
            atts = (
                supabase.table("attachments")
                .select("id, filename, status, error_message")
                .eq("parent_email_id", em["id"])
                .execute()
            )
            result.append({**em, "attachments": atts.data or []})
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


@app.get("/api/attachments/{att_id}/raw")
async def get_raw_text(att_id: str):
    logger.info("[API] GET /api/attachments/%s/raw", att_id)
    try:
        row = (
            supabase.table("attachments")
            .select(
                "raw_text, filename, signature_emails, signature_phones",
            )
            .eq("id", att_id)
            .single()
            .execute()
        )
        if not row.data:
            raise HTTPException(status_code=404, detail="Attachment not found.")
        att = row.data[0]
        return {
            "raw_text": att.get("raw_text"),
            "filename": att.get("filename"),
            "signature_emails": att.get("signature_emails") or "",
            "signature_phones": att.get("signature_phones") or "",
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
        from standard_columns import STANDARD_COLUMN_IDS
        return {"columns": STANDARD_COLUMN_IDS}
    except Exception as exc:
        logger.error("[API] get_superset_columns failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/api/vessels/{vessel_id}")
async def update_vessel(vessel_id: str, body: UpdateVesselRequest):
    logger.info("[API] PUT /api/vessels/%s", vessel_id)
    try:
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
                "dynamic_data": {},
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
