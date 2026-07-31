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

/** Kick off Phase 1. Optional { date_from, date_to } as YYYY-MM-DD. Returns { job_id }. */
export const fetchEmails = (opts = {}) =>
  request("POST", "/fetch-emails", {
    date_from: opts.date_from || null,
    date_to: opts.date_to || null,
  });

/** Retry failed/pending extractions for one parent email. Returns { job_id }. */
export const retryExtraction = (emailId) =>
  request("POST", `/emails/${emailId}/retry-extraction`);

/** Retry extraction for one attachment only. Returns { job_id }. */
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

/** URL to view/download a stored file attachment of an email. */
export const attachmentFileUrl = (attId, idx) => `/api/attachments/${attId}/files/${idx}`;

/** Returns vessels extracted from one attachment (Preview Modal). */
export const getVesselsForAttachment = (attId) =>
  request("GET", `/attachments/${attId}/vessels`);

// ── Validation grid ─────────────────────────────────────────────────────────

/** Returns all vessels across ready parent emails (Vessel Position List tab). */
export const getAllVesselsCombined = () => request("GET", "/vessels");

/** Returns column definitions from PostgreSQL (id, header, display_order, read_only, storage). */
export const getColumnDefinitions = () => request("GET", "/columns");

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

/** Add a position row manually to the Vessel Position List (shows immediately). */
export const createManualVessel = (dynamicData, region) =>
  request("POST", "/vessels/manual", { dynamic_data: dynamicData, region });

// ── Phase 2 ─────────────────────────────────────────────────────────────────

/**
 * Trigger Phase 2.
 * Pass column ids (strings) for the Validate grid, or column objects for the Position List tab.
 * Returns { job_id }.
 */
export const generateDraft = (emailId, vessels, columnsOrGrid = []) => {
  const body = { email_id: emailId, vessels };
  if (columnsOrGrid.length && typeof columnsOrGrid[0] === "string") {
    body.grid_columns = columnsOrGrid;
  } else if (columnsOrGrid.length) {
    body.columns = columnsOrGrid;
  }
  return request("POST", "/generate-draft", body);
};

/** Mark attachment verified/unverified (sends vessels to Position List when verified). */
export const setAttachmentVerified = (attId, verified) =>
  request("PUT", `/attachments/${attId}/verified`, { verified });

/** Returns all broker contact rows with parent email + attachment context. */
export const getContacts = () => request("GET", "/contacts");

/** Update one structured broker contact row. */
export const updateBrokerContact = (contactId, fields) =>
  request("PUT", `/contacts/${contactId}`, fields);

/** Update broker emails/phones for one attachment (vessel grid). */
export const updateAttachmentContacts = (attId, { signature_emails, signature_phones }) =>
  request("PUT", `/attachments/${attId}/contacts`, { signature_emails, signature_phones });

/** Home dashboard: pipeline counts + AI narrative (numbers from SQL). */
export const getHomeSummary = () => request("GET", "/home/summary");

/** Fresh AI summary for the inbox tab (optional email id filter). */
export const summarizeInbox = (emailIds) =>
  request("POST", "/summary/inbox", emailIds?.length ? { email_ids: emailIds } : {});

/** Fresh AI summary for the Vessel Position List (optional vessel id filter). */
export const summarizeVessels = (vesselIds) =>
  request("POST", "/summary/vessels", vesselIds?.length ? { vessel_ids: vesselIds } : {});

/** Fresh AI summary for the Contact List tab. */
export const summarizeContacts = (contactIds) =>
  request("POST", "/summary/contacts", contactIds?.length ? { contact_ids: contactIds } : {});

// ── Vessel Library ───────────────────────────────────────────────────────────

/** Returns { vessels: [...], new_vessels: [...] } for the Vessel Libraries List tab. */
export const getVesselLibrary = () => request("GET", "/vessel-library");

/** Add a vessel to the library (manual entry or promotion from review). */
export const addVesselLibrary = (fields) => request("POST", "/vessel-library", fields);

/** Add all new (unreviewed) vessels from position lists into the library. */
export const autofillVesselLibrary = () => request("POST", "/vessel-library/autofill");

/** Update one vessel in the library. */
export const updateVesselLibrary = (id, fields) => request("PUT", `/vessel-library/${id}`, fields);

/** Delete one vessel from the library. */
export const deleteVesselLibrary = (id) => request("DELETE", `/vessel-library/${id}`);
