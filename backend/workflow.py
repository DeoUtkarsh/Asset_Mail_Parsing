"""
LangGraph Workflow Definitions

Phase 1 Graph  →  ingestion → extraction → normalization
Phase 2 Graph  →  drafter   (single consolidated HTML draft for all vessels)
"""
from typing import Any, TypedDict

from langgraph.graph import StateGraph, START, END

from agents.ingestion import run_ingestion
from agents.extraction import run_extraction
from agents.normalization import run_normalization
from agents.drafter import run_drafter

import logging
logger = logging.getLogger(__name__)


# ── Shared state schemas ─────────────────────────────────────────────────────

class Phase1State(TypedDict):
    job_id: str
    email_id: str
    attachment_ids: list[str]
    attachment_count: int
    superset_columns: list[str]
    error: str


class Phase2State(TypedDict):
    job_id: str
    email_id: str
    vessels: list[dict[str, Any]]
    draft_html: str
    zones: list[dict[str, Any]]   # Leaflet map markers: [{name, lat, lng, count}]
    error: str


# ── Phase 1 Nodes ────────────────────────────────────────────────────────────

async def ingestion_node(state: Phase1State) -> Phase1State:
    try:
        result = await run_ingestion(state["job_id"])
        return {
            **state,
            "email_id": result["email_id"],
            "attachment_ids": result["attachment_ids"],
            "attachment_count": result["attachment_count"],
        }
    except Exception as exc:
        return {**state, "error": str(exc)}


async def extraction_node(state: Phase1State) -> Phase1State:
    if state.get("error"):
        return state
    try:
        await run_extraction(state["job_id"], state["attachment_ids"])
        return state
    except Exception as exc:
        return {**state, "error": str(exc)}


async def normalization_node(state: Phase1State) -> Phase1State:
    if state.get("error"):
        return state
    try:
        superset = await run_normalization(state["job_id"], state["email_id"])
        return {**state, "superset_columns": superset}
    except Exception as exc:
        return {**state, "error": str(exc)}


# ── Phase 2 Node ─────────────────────────────────────────────────────────────

async def drafter_node(state: Phase2State) -> Phase2State:
    """
    Generates one consolidated HTML email for all validated vessels,
    grouped by broad trade zone.
    """
    if state.get("error"):
        return state
    try:
        logger.info(
            "[Phase2] Generating consolidated draft for %d vessels",
            len(state["vessels"]),
        )
        draft_html, zones = await run_drafter(
            state["job_id"],
            state["email_id"],
            state["vessels"],
        )
        return {**state, "draft_html": draft_html, "zones": zones}
    except Exception as exc:
        return {**state, "error": str(exc)}


# ── Graph compilation ────────────────────────────────────────────────────────

def build_phase1_graph():
    builder: StateGraph = StateGraph(Phase1State)
    builder.add_node("ingestion", ingestion_node)
    builder.add_node("extraction", extraction_node)
    builder.add_node("normalization", normalization_node)

    builder.add_edge(START, "ingestion")
    builder.add_edge("ingestion", "extraction")
    builder.add_edge("extraction", "normalization")
    builder.add_edge("normalization", END)

    return builder.compile()


def build_phase2_graph():
    builder: StateGraph = StateGraph(Phase2State)
    builder.add_node("drafter", drafter_node)

    builder.add_edge(START, "drafter")
    builder.add_edge("drafter", END)

    return builder.compile()


# Compiled singletons — imported by main.py
phase1_graph = build_phase1_graph()
phase2_graph = build_phase2_graph()
