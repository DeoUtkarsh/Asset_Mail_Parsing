const BASE = "/api";

async function request(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Phase 1 ────────────────────────────────────────────────────────────────

/** Kick off Phase 1. Returns { job_id }. */
export const fetchEmails = () => request("POST", "/fetch-emails");

// ── Inbox data ──────────────────────────────────────────────────────────────

/** Returns all parent emails with attachment summaries. */
export const getEmails = () => request("GET", "/emails");

/** Returns attachments (including raw_text) for one parent email. */
export const getAttachments = (emailId) =>
  request("GET", `/emails/${emailId}/attachments`);

/** Returns raw_text + filename for one attachment. */
export const getAttachmentRaw = (attId) =>
  request("GET", `/attachments/${attId}/raw`);

/** URL to view/download a stored file attachment of an email. */
export const attachmentFileUrl = (attId, idx) => `/api/attachments/${attId}/files/${idx}`;

/** Returns vessels extracted from one attachment (Preview Modal). */
export const getVesselsForAttachment = (attId) =>
  request("GET", `/attachments/${attId}/vessels`);

// ── Validation grid ─────────────────────────────────────────────────────────

/** Returns all vessels for one email (all attachments merged). */
export const getAllVessels = (emailId) =>
  request("GET", `/emails/${emailId}/vessels`);

/** Returns the ordered superset column list. */
export const getColumns = (emailId) =>
  request("GET", `/emails/${emailId}/columns`);

/** Update a single vessel row (cell edit, region, and/or validated flag). */
export const updateVessel = (vesselId, dynamicData, region, isValidated) => {
  const body = { vessel_id: vesselId, dynamic_data: dynamicData, region };
  if (isValidated !== undefined) body.is_validated = isValidated;
  return request("PUT", `/vessels/${vesselId}`, body);
};

/** Delete a vessel row. */
export const deleteVessel = (vesselId) =>
  request("DELETE", `/vessels/${vesselId}`);

/** Create a new blank vessel row for manual entry. */
export const createVessel = (emailId) =>
  request("POST", `/emails/${emailId}/vessels`);

// ── Phase 2 ─────────────────────────────────────────────────────────────────

/**
 * Trigger Phase 2.
 * vessels = array of { id, dynamic_data, region } from the validation grid.
 * Returns { job_id }.
 */
export const generateDraft = (emailId, vessels, columns) =>
  request("POST", "/generate-draft", { email_id: emailId, vessels, columns });
