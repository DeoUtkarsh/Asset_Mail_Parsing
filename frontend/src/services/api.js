const BASE = "/api";

function errorDetail(err, fallback) {
  const d = err?.detail;
  if (typeof d === "string" && d) return d;
  if (Array.isArray(d) && d.length) {
    return d.map((x) => x?.msg || String(x)).filter(Boolean).join("; ") || fallback;
  }
  return fallback;
}

/** Wait until the FastAPI backend is up (e.g. after uvicorn restart). */
export async function waitForBackend({ maxMs = 45000, intervalMs = 600 } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.status === "ok") return true;
      }
    } catch {
      /* backend still starting */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function requestOnce(method, path, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: ctrl.signal,
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${BASE}${path}`, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(errorDetail(err, `HTTP ${res.status}`));
    }
    return await res.json();
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error("Request timed out. Refresh the page — the backend may still be starting.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(err) {
  const msg = String(err?.message || err);
  return /timed out|Failed to fetch|NetworkError|Backend unavailable|ECONNREFUSED|ECONNRESET|Executor shutdown|502|503/i.test(msg);
}

async function request(method, path, body, { timeoutMs = 20000 } = {}) {
  const attempts = method === "GET" ? 8 : 1;
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await requestOnce(method, path, body, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (i === attempts || !isRetryable(e)) throw e;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  throw lastErr;
}

/** Validate user_id + password (demo admin or DB user). */
export const login = (userId, password) =>
  request("POST", "/auth/login", { user_id: userId, password });

/** Create a login user (demo admin only). */
export const createUser = (userId, password, actorUser, actorPassword) =>
  request("POST", "/auth/users", {
    user_id: userId,
    password,
    actor_user: actorUser,
    actor_password: actorPassword,
  });

// ── Phase 1 ────────────────────────────────────────────────────────────────

/** Kick off Phase 1. Optional { date_from, date_to } as YYYY-MM-DD. Returns { job_id }. */
export const fetchEmails = (opts = {}) =>
  request("POST", "/fetch-emails", {
    date_from: opts.date_from || null,
    date_to: opts.date_to || null,
  });

/** Deployment flags (no secrets). */
export const getRuntimeConfig = () => request("GET", "/runtime-config");

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

/** Upload CSV / Excel / JSON / PDF into Owners directory. Does not change email contacts. */
export async function uploadOwnersCsv(file) {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`${BASE}/contacts/owners-csv`, { method: "POST", body });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(errorDetail(err, `HTTP ${res.status}`));
  }
  return res.json();
}

/** Update broker emails/phones for one attachment (vessel grid). */
export const updateAttachmentContacts = (attId, { signature_emails, signature_phones }) =>
  request("PUT", `/attachments/${attId}/contacts`, { signature_emails, signature_phones });

/** Home dashboard: pipeline counts + AI narrative (numbers from SQL). */
/** Home dashboard: today's counts + AI narrative. Optional { day, tz }. */
export const getHomeSummary = (opts = {}) => {
  const q = new URLSearchParams();
  if (opts.day) q.set("day", opts.day);
  if (opts.tz) q.set("tz", opts.tz);
  const qs = q.toString();
  return request("GET", `/home/summary${qs ? `?${qs}` : ""}`);
};

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

/** Hide a pending review vessel from the New to review list (persists across restart). */
export const skipVesselReview = (matchKey, vesselName = "") =>
  request("POST", "/vessel-library/skip-review", {
    match_key: matchKey,
    vessel_name: vesselName || "",
  });

/** Add a vessel to the library (manual entry or promotion from review). */
export const addVesselLibrary = (fields) => request("POST", "/vessel-library", fields);

/** Add all new (unreviewed) vessels from position lists into the library. */
export const autofillVesselLibrary = () => request("POST", "/vessel-library/autofill");

/** Update one vessel in the library. */
export const updateVesselLibrary = (id, fields) => request("PUT", `/vessel-library/${id}`, fields);

/** Delete one vessel from the library. */
export const deleteVesselLibrary = (id) => request("DELETE", `/vessel-library/${id}`);

/** Latest Q88 extract for one library vessel. */
export const getVesselQ88 = (vesselId) => request("GET", `/vessel-library/${vesselId}/q88`);

/** Download URL for the stored Q88 PDF. */
export const vesselQ88DownloadUrl = (vesselId) =>
  `${BASE}/vessel-library/${encodeURIComponent(vesselId)}/q88/download`;

/** Create a contact manually. */
export const createBrokerContact = (fields) => request("POST", "/contacts", fields);

/** Upload a Q88 PDF. Replaces any previous extract for that vessel. */
export async function uploadVesselQ88(vesselId, file, { ignoreMismatch = false } = {}) {
  const body = new FormData();
  body.append("file", file);
  const q = ignoreMismatch ? "?ignore_mismatch=true" : "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(`${BASE}/vessel-library/${encodeURIComponent(vesselId)}/q88${q}`, {
      method: "POST",
      body,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      const detail = data.detail && typeof data.detail === "object" ? data.detail : { message: data.detail };
      const err = new Error(detail.message || "This PDF may be for a different vessel.");
      err.mismatch = detail;
      throw err;
    }
    if (!res.ok) throw new Error(errorDetail(data, `HTTP ${res.status}`));
    return data;
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error("Q88 extract timed out. Try again.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
