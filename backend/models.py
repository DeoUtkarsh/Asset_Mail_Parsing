from pydantic import BaseModel
from typing import Any, Optional
from datetime import datetime


# ── Inbound request bodies ────────────────────────────────────────

class FetchEmailsRequest(BaseModel):
    """Optional IMAP date window (YYYY-MM-DD). Empty = fetch all (legacy)."""
    date_from: Optional[str] = None
    date_to: Optional[str] = None


class GenerateDraftRequest(BaseModel):
    """Sent by the frontend when the user approves the validation grid."""
    email_id: str
    # List of vessel dicts with user-edited dynamic_data
    vessels: list[dict[str, Any]]
    # Optional user-chosen columns: [{header, keys:[...]}]. Falls back to the standard set.
    columns: Optional[list[dict[str, Any]]] = None
    # Same order as Validate tab (from GET /columns); drives draft table headers/cells
    grid_columns: Optional[list[str]] = None


class SummaryScopeRequest(BaseModel):
    """Optional ID filters — empty list means current tab has no rows; omit for all in DB."""
    email_ids: Optional[list[str]] = None
    vessel_ids: Optional[list[str]] = None
    contact_ids: Optional[list[str]] = None


class SetAttachmentVerifiedRequest(BaseModel):
    verified: bool


class UpdateAttachmentContactsRequest(BaseModel):
    """Update broker signature emails/phones for one attachment."""
    signature_emails: Optional[str] = None
    signature_phones: Optional[str] = None


class UpdateBrokerContactRequest(BaseModel):
    """Update one structured broker contact row."""
    contact_name: Optional[str] = None
    designation: Optional[str] = None
    department: Optional[str] = None
    company: Optional[str] = None
    company_type: Optional[str] = None
    vessel_name: Optional[str] = None
    email: Optional[str] = None
    off_phone: Optional[str] = None
    mob_phone: Optional[str] = None
    wechat: Optional[str] = None
    whatsapp: Optional[str] = None
    website_address: Optional[str] = None
    office_address: Optional[str] = None
    other_info: Optional[str] = None
    status: Optional[str] = None


class UpdateVesselRequest(BaseModel):
    """Single-cell or full-row update from the validation grid."""
    vessel_id: str
    dynamic_data: dict[str, Any]
    region: Optional[str] = None
    is_validated: Optional[bool] = None


class ManualVesselRequest(BaseModel):
    """Add a position row manually to the Vessel Position List."""
    dynamic_data: dict[str, Any] = {}
    region: Optional[str] = ""


class VesselLibraryRequest(BaseModel):
    """Add or update a vessel in the Vessel Library."""
    vessel_name: Optional[str] = ""
    imo_no: Optional[str] = ""
    imo_type: Optional[str] = ""
    dwt: Optional[str] = ""
    year_built: Optional[str] = ""
    tank_coating: Optional[str] = ""
    vessel_type: Optional[str] = ""


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
