"""
LangGraph Workflow Definitions

Phase 1 Graph  →  ingestion → process_emails
  process_emails:
    1) extract ALL new attachments in parallel (vessels)
    2) normalize each parent email
    3) signature + contacts per email → email_ready (openable only then)

Phase 2 Graph  →  drafter
"""
from typing import Any, TypedDict

from langgraph.graph import StateGraph, START, END

from agents.ingestion import run_ingestion
from agents.extraction import run_extraction
from agents.normalization import run_normalization
from agents.drafter import run_drafter
from agents.signature_extract import run_parent_signature_extraction
from agents.contact_extract import run_parent_contact_extraction
from database import supabase
from sse_manager import sse_manager

import pipeline_log as plog

import logging
logger = logging.getLogger(__name__)


class Phase1State(TypedDict):
    job_id: str
    email_ids: list[str]
    attachment_ids: list[str]
    attachment_count: int
    superset_columns: list[str]
    error: str
    date_from: str
    date_to: str
    min_uid: int
    max_imap_uid: int


class Phase2State(TypedDict):
    job_id: str
    email_id: str
    vessels: list[dict[str, Any]]
    columns: list[dict[str, Any]]
    grid_columns: list[str]
    draft_html: str
    zones: list[dict[str, Any]]
    error: str


async def ingestion_node(state: Phase1State) -> Phase1State:
    try:
        raw = state.get("min_uid")
        try:
            min_uid_val = int(raw) if raw not in (None, "") else -1
        except (TypeError, ValueError):
            min_uid_val = -1
        with plog.step(
            "Phase1",
            "IMAP ingestion",
            job=state["job_id"][:8],
            date_from=state.get("date_from") or "any",
            date_to=state.get("date_to") or "any",
            min_uid=min_uid_val if min_uid_val >= 0 else "off",
        ):
            result = await run_ingestion(
                state["job_id"],
                date_from=(state.get("date_from") or None),
                date_to=(state.get("date_to") or None),
                min_uid=min_uid_val if min_uid_val >= 0 else None,
            )
        plog.info(
            "Phase1",
            "Ingestion result",
            emails=len(result["email_ids"]),
            attachments=result["attachment_count"],
            new=result.get("new_count", 0),
            found=result.get("total_found", 0),
        )
        return {
            **state,
            "email_ids": result["email_ids"],
            "attachment_ids": result["attachment_ids"],
            "attachment_count": result["attachment_count"],
            "max_imap_uid": int(result.get("max_imap_uid") or 0),
        }
    except Exception as exc:
        plog.exception("Phase1", "Ingestion failed", job=state["job_id"][:8])
        return {**state, "error": str(exc)}


async def process_emails_node(state: Phase1State) -> Phase1State:
    """
    Parallel vessel extract for all new mails, then per-mail contacts.
    email_ready fires only after that mail's vessels + contacts are done.
    """
    if state.get("error"):
        return state

    email_ids = state.get("email_ids") or []
    attachment_ids = state.get("attachment_ids") or []
    if not email_ids:
        plog.info("Phase1", "No new emails — skipping processing", job=state["job_id"][:8])
        return state

    columns: list[str] = []
    seen: set[str] = set()

    try:
        if attachment_ids:
            plog.info(
                "Phase1",
                "Vessel extraction starting",
                job=state["job_id"][:8],
                attachments=len(attachment_ids),
            )
            await sse_manager.send(state["job_id"], "vessels_phase_started", {
                "email_ids": email_ids,
                "attachment_ids": attachment_ids,
                "message": "Extracting vessels…",
            })
            total_v = await run_extraction(state["job_id"], attachment_ids)
            plog.info("Phase1", "Vessel extraction done", vessels=total_v)

        plog.info("Phase1", "Normalization", emails=len(email_ids))
        for email_id in email_ids:
            try:
                superset = await run_normalization(state["job_id"], email_id)
                for col in superset:
                    if col not in seen:
                        seen.add(col)
                        columns.append(col)
            except Exception as norm_exc:
                logger.exception("[Phase1] Normalization failed for %s: %s", email_id, norm_exc)

        plog.info("Phase1", "Contact extraction", emails=len(email_ids))
        await sse_manager.send(state["job_id"], "contacts_phase_started", {
            "email_ids": email_ids,
            "message": "Vessel extraction done — extracting contacts…",
        })

        for email_id in email_ids:
            att_rows = (
                supabase.table("attachments")
                .select("id")
                .eq("parent_email_id", email_id)
                .execute()
            ).data or []
            att_ids = [a["id"] for a in att_rows]

            await sse_manager.send(state["job_id"], "email_contacts_started", {
                "email_id": email_id,
                "attachment_ids": att_ids,
            })
            plog.info("Phase1", "Processing email", email_id=email_id[:8], attachments=len(att_ids))
            try:
                await run_parent_signature_extraction(state["job_id"], email_id)
                await run_parent_contact_extraction(state["job_id"], email_id)
            except Exception as sig_exc:
                plog.exception("Phase1", "Signature/contact failed", email_id=email_id[:8])
                logger.exception(
                    "[Phase1] Signature/contact extraction failed for %s: %s",
                    email_id,
                    sig_exc,
                )

            supabase.table("parent_emails").update({
                "status": "ready_for_validation",
            }).eq("id", email_id).execute()

            await sse_manager.send(state["job_id"], "email_ready", {
                "email_id": email_id,
                "attachment_ids": att_ids,
            })
            plog.info("Phase1", "Email ready", email_id=email_id[:8])

        return {**state, "superset_columns": columns}
    except Exception as exc:
        return {**state, "error": str(exc)}


async def drafter_node(state: Phase2State) -> Phase2State:
    if state.get("error"):
        return state
    try:
        with plog.step(
            "Phase2",
            "Draft email",
            job=state["job_id"][:8],
            vessels=len(state["vessels"]),
        ):
            draft_html, zones = await run_drafter(
                state["job_id"],
                state["email_id"],
                state["vessels"],
                state.get("grid_columns") or None,
            )
        plog.info("Phase2", "Draft ready", zones=len(zones), chars=len(draft_html))
        return {**state, "draft_html": draft_html, "zones": zones}
    except Exception as exc:
        plog.exception("Phase2", "Draft failed", job=state["job_id"][:8])
        return {**state, "error": str(exc)}


def build_phase1_graph():
    builder: StateGraph = StateGraph(Phase1State)
    builder.add_node("ingestion", ingestion_node)
    builder.add_node("process_emails", process_emails_node)

    builder.add_edge(START, "ingestion")
    builder.add_edge("ingestion", "process_emails")
    builder.add_edge("process_emails", END)

    return builder.compile()


def build_phase2_graph():
    builder: StateGraph = StateGraph(Phase2State)
    builder.add_node("drafter", drafter_node)

    builder.add_edge(START, "drafter")
    builder.add_edge("drafter", END)

    return builder.compile()


phase1_graph = build_phase1_graph()
phase2_graph = build_phase2_graph()
