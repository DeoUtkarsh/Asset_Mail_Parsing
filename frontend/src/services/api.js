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

/** Retry failed/pending extractions for one parent email. Returns { job_id }. */
export const retryExtraction = (emailId) =>
  request("POST", `/emails/${emailId}/retry-extraction`);

/** Retry extraction + signatures for one attachment only. Returns { job_id }. */
export const retryAttachment = (attId) =>
  request("POST", `/attachments/${attId}/retry-extraction`);

// ── Inbox data ──────────────────────────────────────────────────────────────

/** Returns all parent emails with attachment summaries. */
export const getEmails = () => request("GET", "/emails");

/** Returns attachments (including raw_text) for one parent email. */
export const getAttachments = (emailId) =>
  request("GET", `/emails/${emailId}/attachments`);

/** Returns raw_text + filename for one attachment. */
export const getAttachmentRaw = (attId) =>
  request("GET", `/attachments/${attId}/raw`);

/** Returns vessels extracted from one attachment (Preview Modal). */
export const getVesselsForAttachment = (attId) =>
  request("GET", `/attachments/${attId}/vessels`);

// ── Validation grid ─────────────────────────────────────────────────────────

/** Returns all vessels for one email (all attachments merged). */
export const getAllVessels = (emailId) =>
  request("GET", `/emails/${emailId}/vessels`);

/** Returns all vessels across every validation-ready parent email in the DB. */
export const getAllVesselsCombined = () => request("GET", "/vessels");

/** Returns column definitions from PostgreSQL (id, header, display_order, read_only, storage). */
export const getColumnDefinitions = () => request("GET", "/columns");

/** Returns the ordered superset column list. */
export const getColumns = (emailId) =>
  request("GET", `/emails/${emailId}/columns`);

/** Returns all broker contact rows with parent email + attachment context. */
export const getContacts = () => request("GET", "/contacts");

/** Update one structured broker contact row. */
export const updateBrokerContact = (contactId, fields) =>
  request("PUT", `/contacts/${contactId}`, fields);

/** Update broker emails/phones for one attachment (vessel grid). */
export const updateAttachmentContacts = (attId, { signature_emails, signature_phones }) =>
  request("PUT", `/attachments/${attId}/contacts`, { signature_emails, signature_phones });

/** Update a single vessel row (cell edit). */
export const updateVessel = (vesselId, dynamicData, region) =>
  request("PUT", `/vessels/${vesselId}`, { vessel_id: vesselId, dynamic_data: dynamicData, region });

/** Delete a vessel row. */
export const deleteVessel = (vesselId) =>
  request("DELETE", `/vessels/${vesselId}`);

/** Create a new blank vessel row for manual entry. */
export const createVessel = (emailId) =>
  request("POST", `/emails/${emailId}/vessels`);

// ── Attachment verification ─────────────────────────────────────────────────

export const setAttachmentVerified = (attId, verified) =>
  request("PUT", `/attachments/${attId}/verified`, { verified });

export const verifyAllAttachments = () =>
  request("POST", "/attachments/verify-all");

export const verifyEmailAttachments = (emailId) =>
  request("POST", `/emails/${emailId}/verify-attachments`);

// ── Phase 2 ─────────────────────────────────────────────────────────────────

/**
 * Trigger Phase 2.
 * vessels = array of { id, dynamic_data, region } from the validation grid.
 * Returns { job_id }.
 */
export const generateDraft = (emailId, vessels, gridColumns = []) =>
  request("POST", "/generate-draft", {
    email_id: emailId,
    vessels,
    grid_columns: gridColumns,
  });

// ── AI Summary (fresh on each modal open) ───────────────────────────────────

export const summarizeInbox = (emailIds) =>
  request("POST", "/summary/inbox", emailIds?.length ? { email_ids: emailIds } : {});

export const summarizeVessels = (vesselIds) =>
  request("POST", "/summary/vessels", vesselIds?.length ? { vessel_ids: vesselIds } : {});

export const summarizeContacts = (contactIds) =>
  request("POST", "/summary/contacts", contactIds?.length ? { contact_ids: contactIds } : {});
