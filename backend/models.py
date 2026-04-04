from pydantic import BaseModel
from typing import Any, Optional
from datetime import datetime


# ── Inbound request bodies ────────────────────────────────────────

class FetchEmailsRequest(BaseModel):
    """No body needed; kept for future filters."""
    pass


class GenerateDraftRequest(BaseModel):
    """Sent by the frontend when the user approves the validation grid."""
    email_id: str
    # List of vessel dicts with user-edited dynamic_data
    vessels: list[dict[str, Any]]


class UpdateVesselRequest(BaseModel):
    """Single-cell or full-row update from the validation grid."""
    vessel_id: str
    dynamic_data: dict[str, Any]
    region: Optional[str] = None


# ── API response shapes ───────────────────────────────────────────

class AttachmentOut(BaseModel):
    id: str
    filename: str
    status: str
    error_message: Optional[str] = None


class EmailOut(BaseModel):
    id: str
    subject: str
    sender: str
    date_received: datetime
    status: str
    attachments: list[AttachmentOut] = []


class VesselOut(BaseModel):
    id: str
    attachment_id: str
    dynamic_data: dict[str, Any]
    region: Optional[str] = None
    is_validated: bool = False


class DraftOut(BaseModel):
    email_id: str
    draft_text: str


# ── LangGraph state dicts ─────────────────────────────────────────

class Phase1State(dict):
    """Passed through the Phase 1 LangGraph nodes."""
    email_id: str
    job_id: str
    attachment_ids: list[str]


class Phase2State(dict):
    """Passed through the Phase 2 LangGraph nodes."""
    email_id: str
    job_id: str
    vessels: list[dict[str, Any]]
    draft_text: str
