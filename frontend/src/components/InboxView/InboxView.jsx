import { useState, useEffect, useCallback, useMemo } from "react";
import {
  fetchEmails,
  getEmails,
  retryExtraction,
  retryAttachment,
} from "../../services/api";
import { useSSE } from "../../hooks/useSSE";
import PreviewPanel from "./PreviewPanel";
import AiSummaryButton from "../AiSummary/AiSummaryButton";
import { summarizeInbox } from "../../services/api";
import Icon from "../icons";

const AV_COLORS = ["#219495", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#10b981", "#ec4899", "#0ea5e9"];

const DEFAULT_FILTERS = { from: "", dateFrom: "", dateTo: "", tiers: [], verification: "all" };

function mapDbStatus(status) {
  if (status === "done") return "downloaded";
  if (status === "error") return "failed";
  if (status === "extracting" || status === "pending") return "in_progress";
  return status;
}

export default function InboxView({ onEmailReady, onVesselsUpdated, onContactsUpdated, reviewMode = false }) {
  const [emails, setEmails]           = useState([]);
  const [fetching, setFetching]       = useState(false);
  const [retrying, setRetrying]       = useState(false);
  const [jobId, setJobId]             = useState(null);
  const [statusLog, setStatusLog]     = useState([]);
  const [attStatuses, setAttStatuses] = useState({});
  // Inbox and Need-to-Review share this component instance, so keep a separate
  // open-mail + search per tab — each tab remembers its own selection.
  const [selById, setSelById]         = useState({ inbox: null, review: null });
  const [searchByMode, setSearchByMode] = useState({ inbox: "", review: "" });
  const modeKey = reviewMode ? "review" : "inbox";
  const selectedId = selById[modeKey];
  const setSelectedId = useCallback((id) => setSelById((p) => ({ ...p, [modeKey]: id })), [modeKey]);
  const search = searchByMode[modeKey];
  const setSearch = useCallback((v) => setSearchByMode((p) => ({ ...p, [modeKey]: v })), [modeKey]);
  // Filters are also kept per tab (inbox vs review).
  const [filtersByMode, setFiltersByMode] = useState({ inbox: DEFAULT_FILTERS, review: DEFAULT_FILTERS });
  const filters = filtersByMode[modeKey];
  const setFilters = useCallback((next) => setFiltersByMode((p) => ({ ...p, [modeKey]: next })), [modeKey]);
  const [filterOpen, setFilterOpen] = useState(false);

  useEffect(() => { loadEmails(); }, []);

  const pickReadyEmail = (data) => {
    const ready = data.find(
      (e) => e.status === "ready_for_validation" || e.status === "drafted"
    );
    if (ready?.id) onEmailReady?.(ready.id);
  };

  const loadEmails = async () => {
    try {
      const data = await getEmails();
      setEmails(data);
      pickReadyEmail(data);
    } catch (e) {
      console.error("Failed to load emails:", e);
    }
  };

  const isRetryableAtt = (att) => {
    const live = attStatuses[att.id];
    if (live === "in_progress") return false;
    if (live === "failed") return true;
    if (att.status === "error") return true;
    return Boolean(att.retry_suggested);
  };

  const retryTarget = useMemo(() => {
    for (const em of emails) {
      const count = (em.attachments || []).filter(isRetryableAtt).length;
      if (count > 0) return { emailId: em.id, count };
    }
    return null;
  }, [emails, attStatuses]);

  const finishJob = useCallback(() => {
    setFetching(false);
    setRetrying(false);
    setJobId(null);
    setAttStatuses({});
    loadEmails();
  }, []);

  const handleEvent = useCallback((evt) => {
    const { type, ...rest } = evt;
    setStatusLog((prev) => [{ type, ...rest, ts: Date.now() }, ...prev].slice(0, 50));
    switch (type) {
      case "retry_started":
        if (rest.attachment_id) {
          setAttStatuses((p) => ({ ...p, [rest.attachment_id]: "in_progress" }));
        }
        break;
      case "email_saved":
        loadEmails();
        break;
      case "attachment_saved":
        setAttStatuses((p) => ({ ...p, [rest.attachment_id]: "in_progress" }));
        break;
      case "extraction_started":
      case "signature_attachment_started":
        setAttStatuses((p) => ({ ...p, [rest.attachment_id]: "in_progress" }));
        break;
      case "extraction_done":
        setAttStatuses((p) => ({ ...p, [rest.attachment_id]: "in_progress" }));
        break;
      case "signature_attachment_done":
        setAttStatuses((p) => ({ ...p, [rest.attachment_id]: "downloaded" }));
        onContactsUpdated?.();
        break;
      case "extraction_error":
        setAttStatuses((p) => ({ ...p, [rest.attachment_id]: "failed" }));
        break;
      case "batch_ingestion_complete":
        loadEmails();
        onContactsUpdated?.();
        break;
      case "parent_email_done":
        loadEmails();
        onVesselsUpdated?.();
        onContactsUpdated?.();
        break;
      case "phase1_complete":
        if (rest.email_id) onEmailReady?.(rest.email_id);
        onVesselsUpdated?.();
        onContactsUpdated?.();
        finishJob();
        break;
      case "phase1_no_new":
        finishJob();
        break;
      case "retry_no_work":
        finishJob();
        break;
      case "phase1_failed":
        finishJob();
        break;
      case "signature_extraction_started":
      case "signature_extraction_done":
      case "signature_extraction_error":
        if (type === "signature_extraction_done") {
          loadEmails();
          onContactsUpdated?.();
        }
        break;
      default:
        break;
    }
  }, [onEmailReady, onVesselsUpdated, onContactsUpdated, finishJob]);

  useSSE(jobId, handleEvent);

  const handleFetch = async () => {
    setFetching(true);
    setStatusLog([]);
    try {
      const { job_id } = await fetchEmails();
      setJobId(job_id);
    } catch (e) {
      setFetching(false);
      alert("Failed to start fetch: " + e.message);
    }
  };

  const handleRetry = async () => {
    if (!retryTarget?.emailId) return;
    setRetrying(true);
    setStatusLog([]);
    try {
      const { job_id } = await retryExtraction(retryTarget.emailId);
      setJobId(job_id);
    } catch (e) {
      setRetrying(false);
      alert("Failed to start retry: " + e.message);
    }
  };

  const handleRetryAttachment = async (attId) => {
    setAttStatuses((p) => ({ ...p, [attId]: "in_progress" }));
    setStatusLog([]);
    try {
      const { job_id } = await retryAttachment(attId);
      setJobId(job_id);
    } catch (e) {
      setAttStatuses((p) => ({ ...p, [attId]: "failed" }));
      alert("Failed to retry attachment: " + e.message);
    }
  };

  const patchAttachmentVerified = useCallback((attId, isVerified) => {
    setEmails((prev) =>
      prev.map((em) => ({
        ...em,
        attachments: (em.attachments || []).map((att) =>
          att.id === attId ? { ...att, is_verified: isVerified } : att
        ),
      }))
    );
  }, []);

  const fetchBusy = fetching;
  const anyJobActive = Boolean(jobId);

  const fetchInboxSummary = useCallback(
    () => summarizeInbox(emails.map((e) => e.id)),
    [emails],
  );

  const resolveAttStatus = (att) => {
    if (attStatuses[att.id]) return attStatuses[att.id];
    return mapDbStatus(att.status);
  };

  const fmtDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  };
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  // Flat list of attachment cards, newest first.
  const mailRows = useMemo(() => {
    const rows = [];
    for (const em of emails) {
      for (const att of em.attachments || []) {
        rows.push({ ...att, email: em });
      }
    }
    rows.sort(
      (a, b) => new Date(b.email.date_received) - new Date(a.email.date_received)
    );
    return rows;
  }, [emails]);

  // Review tab: only medium/low confidence + failed attachments.
  const scopedRows = useMemo(() => {
    if (!reviewMode) return mailRows;
    return mailRows.filter((r) => {
      const tier = r.confidence_tier;
      return tier === "medium" || tier === "low" || resolveAttStatus(r) === "failed";
    });
  }, [reviewMode, mailRows, attStatuses]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const from = filters.from.trim().toLowerCase();
    const fromTs = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : null;
    const toTs = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59`).getTime() : null;
    const tierSet = filters.tiers.length ? new Set(filters.tiers) : null;
    return scopedRows.filter((r) => {
      if (q) {
        const hay = `${r.filename || ""} ${r.email.sender || ""} ${r.email.subject || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (from && !(r.email.sender || "").toLowerCase().includes(from)) return false;
      if (fromTs != null || toTs != null) {
        const t = r.email.date_received ? new Date(r.email.date_received).getTime() : NaN;
        if (isNaN(t)) return false;
        if (fromTs != null && t < fromTs) return false;
        if (toTs != null && t > toTs) return false;
      }
      if (tierSet && !tierSet.has(r.confidence_tier)) return false;
      if (filters.verification === "verified" && !r.is_verified) return false;
      if (filters.verification === "unverified" && r.is_verified) return false;
      return true;
    });
  }, [scopedRows, search, filters]);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.from.trim()) n += 1;
    if (filters.dateFrom || filters.dateTo) n += 1;
    if (filters.tiers.length) n += 1;
    if (filters.verification !== "all") n += 1;
    return n;
  }, [filters]);

  const inboxStats = useMemo(() => {
    let attachments = 0;
    let downloaded = 0;
    let verified = 0;
    let vessels = 0;
    const emailIds = new Set();
    for (const row of scopedRows) {
      emailIds.add(row.email.id);
      attachments += 1;
      if (resolveAttStatus(row) === "downloaded") downloaded += 1;
      if (row.is_verified) verified += 1;
      vessels += row.vessel_count || 0;
    }
    return {
      emails: reviewMode ? emailIds.size : emails.length,
      attachments,
      downloaded,
      verified,
      vessels,
    };
  }, [scopedRows, reviewMode, emails, attStatuses]);

  const selectedRow = useMemo(
    () => mailRows.find((r) => r.id === selectedId) || null,
    [mailRows, selectedId]
  );

  return (
    <div className="vgrid-root">

      <div className="vgrid-head">
        <div className="vgrid-title">
          <h2>{reviewMode ? "Need to Review" : "Vessel Extracted Data"}</h2>
          {reviewMode && (
            <span className="vgrid-sub">Please review the medium & low confidence mails.</span>
          )}
        </div>
        <div className="vgrid-actions">
          {retryTarget && !anyJobActive ? (
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying || anyJobActive}
              className="btn btn-ghost inbox-retry-btn"
            >
              {retrying ? (
                <><span className="spin-ring" /> Retrying…</>
              ) : (
                `Retry Failed (${retryTarget.count})`
              )}
            </button>
          ) : null}
          <AiSummaryButton
            fetchSummary={fetchInboxSummary}
            title="Email Extraction Inbox — AI Summary"
            disabled={emails.length === 0 || anyJobActive}
            className="tb-btn"
          />
          <button
            type="button"
            onClick={handleFetch}
            disabled={fetchBusy || anyJobActive}
            className="btn btn-send"
            style={{ fontSize: 13, padding: "9px 15px" }}
          >
            {fetchBusy ? (
              <><span className="spin-ring" /> Fetch in progress…</>
            ) : (
              "Fetch Emails"
            )}
          </button>
        </div>
      </div>

      {emails.length > 0 && (
        <div className="vgrid-stats">
          <InboxStat label="Emails" value={inboxStats.emails} />
          <InboxStat label="Attachments" value={inboxStats.attachments} />
          <InboxStat label="Downloaded" value={inboxStats.downloaded} />
          <InboxStat label="Verified" value={inboxStats.verified} />
          <InboxStat label="Vessels" value={inboxStats.vessels} />
        </div>
      )}

      {statusLog.length > 0 && (
        <div className="inbox-log">
          {statusLog.map((log, i) => (
            <div key={i} className="inbox-log-entry">
              <span className="inbox-log-type">[{log.type}]</span>{" "}
              {log.filename && <span>{log.filename}</span>}
              {log.message && <span> {log.message}</span>}
              {log.signature_preview != null && log.signature_preview !== "" && (
                <span> {log.signature_preview}</span>
              )}
              {log.error && <span className="inbox-log-err"> {log.error}</span>}
              {log.vessel_count !== undefined && (
                <span> → {log.vessel_count} vessels</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="inbox-split">
        {/* ── Left: mail list ── */}
        <div className="inbox-list">
          <div className="inbox-search-row">
            <div className="inbox-search">
              <Icon name="search" size={15} />
              <input
                placeholder="Search mails…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button
              type="button"
              className={`inbox-filter-btn ${activeFilterCount ? "has-active" : ""}`}
              onClick={() => setFilterOpen((o) => !o)}
              title="Filters"
            >
              <Icon name="filter" size={15} /> Filters
              {activeFilterCount > 0 && <span className="inbox-filter-count">{activeFilterCount}</span>}
            </button>
            {filterOpen && (
              <InboxFilterPanel
                initial={filters}
                hideHigh={reviewMode}
                onApply={(f) => { setFilters(f); setFilterOpen(false); }}
                onClear={() => { setFilters(DEFAULT_FILTERS); setFilterOpen(false); }}
                onClose={() => setFilterOpen(false)}
              />
            )}
          </div>
          <div className="inbox-list-scroll">
            {mailRows.length === 0 ? (
              <div className="inbox-list-empty">
                {fetchBusy ? "Fetching…" : "No emails fetched yet. Click \u201CFetch Emails\u201D to start."}
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="inbox-list-empty">
                {search.trim() || activeFilterCount
                  ? "No mails match your search or filters."
                  : reviewMode
                    ? "Nothing to review \uD83C\uDF89"
                    : "No mails to show."}
              </div>
            ) : (
              filteredRows.map((row) => {
                const status = resolveAttStatus(row);
                const verified = Boolean(row.is_verified);
                const sender = row.email.sender || "—";
                const avColor = AV_COLORS[(sender.charCodeAt(0) || 0) % AV_COLORS.length];
                return (
                  <div
                    key={row.id}
                    role="button"
                    tabIndex={0}
                    className={`imail-card ${selectedId === row.id ? "active" : ""} ${status === "failed" ? "is-failed" : ""}`}
                    onClick={() => setSelectedId(row.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(row.id);
                      }
                    }}
                  >
                    <div className="imail-top">
                      <span className="imail-av" style={{ background: avColor }}>
                        {sender[0]?.toUpperCase() || "•"}
                      </span>
                      <span className="imail-from" title={sender}>{sender}</span>
                      <span className="imail-date">
                        {fmtDate(row.email.date_received)} {fmtTime(row.email.date_received)}
                      </span>
                    </div>
                    <div className="imail-subj" title={row.email.subject}>
                      {row.email.subject || "(no subject)"}
                    </div>
                    <div className="imail-file" title={row.filename || undefined}>
                      <Icon name="clip" size={12} />
                      <span>{row.filename || "—"}</span>
                    </div>
                    <div className="imail-badges">
                      <StatusBadge status={status} />
                      <div className="imail-actions">
                        {status === "failed" && (
                          <button
                            type="button"
                            className="inbox-btn inbox-btn-danger"
                            disabled={anyJobActive}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRetryAttachment(row.id);
                            }}
                          >
                            Retry
                          </button>
                        )}
                      </div>
                      <ConfidenceBadge
                        score={row.confidence_score}
                        tier={row.confidence_tier}
                        label={row.confidence_label}
                        status={status}
                        reviewed={Boolean(row.manually_reviewed)}
                      />
                      <VerifiedIndicator verified={verified} />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── Right: detail pane ── */}
        <div className="inbox-detail">
          {selectedRow ? (
            <PreviewPanel
              key={selectedRow.id}
              attachmentId={selectedRow.id}
              filename={selectedRow.filename}
              emailId={selectedRow.email.id}
              initialVerified={Boolean(selectedRow.is_verified)}
              vesselCount={selectedRow.vessel_count || 0}
              onVerifiedChange={(isVerified) => {
                patchAttachmentVerified(selectedRow.id, isVerified);
                onVesselsUpdated?.();
                loadEmails();
              }}
              onDataChange={() => {
                onVesselsUpdated?.();
              }}
            />
          ) : (
            <div className="inbox-detail-empty">
              <div className="ide-icon"><Icon name="mail" size={34} /></div>
              <div>Select a mail on the left to preview its extracted vessels and original message.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InboxFilterPanel({ initial, hideHigh = false, onApply, onClear }) {
  const [from, setFrom] = useState(initial.from);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [tiers, setTiers] = useState(initial.tiers);
  const [verification, setVerification] = useState(initial.verification);

  const toggleTier = (t) =>
    setTiers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const tierOptions = [["high", "High"], ["medium", "Medium"], ["low", "Low"]]
    .filter(([v]) => !(hideHigh && v === "high"));

  return (
    <div className="inbox-filter-pop" onClick={(e) => e.stopPropagation()}>
      <label className="iflt-group">
        <span className="iflt-label">FROM</span>
        <input
          className="iflt-input"
          placeholder="Sender name or email…"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>

      <div className="iflt-group">
        <span className="iflt-label">DATE RANGE</span>
        <div className="iflt-dates">
          <input
            type="date"
            className="iflt-input"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <span className="iflt-dash">–</span>
          <input
            type="date"
            className="iflt-input"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
      </div>

      <div className="iflt-group">
        <span className="iflt-label">CONFIDENCE</span>
        <div className="iflt-tiers">
          {tierOptions.map(([v, l]) => (
            <button
              type="button"
              key={v}
              className={`iflt-chip ${v} ${tiers.includes(v) ? "on" : ""}`}
              onClick={() => toggleTier(v)}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <label className="iflt-group">
        <span className="iflt-label">VERIFICATION</span>
        <select
          className="iflt-input iflt-select"
          value={verification}
          onChange={(e) => setVerification(e.target.value)}
        >
          <option value="all">All</option>
          <option value="verified">Verified</option>
          <option value="unverified">Unverified</option>
        </select>
      </label>

      <div className="iflt-btns">
        <button type="button" className="tb-btn" onClick={onClear}>Clear</button>
        <button
          type="button"
          className="tb-btn tb-btn-primary"
          onClick={() => onApply({ from, dateFrom, dateTo, tiers, verification })}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function InboxStat({ label, value }) {
  return (
    <div className="vgrid-stat">
      <span>{label}: </span>
      <b>{value}</b>
    </div>
  );
}

function VerifiedIndicator({ verified }) {
  return (
    <span className={`imail-verified ${verified ? "is-on" : ""}`}>
      {verified ? "✓ Verified" : "Unverified"}
    </span>
  );
}

function ConfidenceBadge({ score, tier, label, status, reviewed = false }) {
  if (status === "in_progress" || status === "pending" || tier === "unknown" || score == null) {
    return <span className="cell-val is-empty" title="Score available after extraction">—</span>;
  }

  const band = tier === "high" ? "hi" : tier === "medium" ? "mid" : "lo";
  const triageHint =
    tier === "high"
      ? "usually safe to verify quickly"
      : tier === "medium"
        ? "quick preview recommended"
        : "inspect before verifying";
  const reviewedHint = reviewed ? " · Edited in preview (not verified)" : "";

  return (
    <span
      className={`conf ${band}`}
      title={`Pipeline confidence ${score}/100 — ${triageHint}${reviewedHint}`}
    >
      <span className="cd" />
      {label || `${score} ${tier}`}
    </span>
  );
}

function StatusBadge({ status }) {
  const map = {
    in_progress: { label: "In Progress", cls: "st-proc", spin: true },
    downloaded:  { label: "Downloaded", cls: "st-auto", spin: false },
    failed:      { label: "Failed", cls: "st-err", spin: false },
    pending:     { label: "Pending", cls: "st-out", spin: false },
  };
  const s = map[status] || map.pending;
  return (
    <span className={`st-pill ${s.cls}`}>
      {s.spin && <span className="spin-ring" style={{ width: 12, height: 12, marginRight: 4 }} />}
      {s.label}
    </span>
  );
}
