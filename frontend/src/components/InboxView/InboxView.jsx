import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  fetchEmails,
  getEmails,
  getRuntimeConfig,
  retryExtraction,
  retryAttachment,
} from "../../services/api";
import { useSSE } from "../../hooks/useSSE";
import PreviewPanel from "./PreviewPanel";
import Icon from "../icons";
import DateRangePicker from "../DateRangePicker/DateRangePicker";

const AV_COLORS = ["#219495", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#10b981", "#ec4899", "#0ea5e9"];
const LIVE_BUS_ID = "live";

const DEFAULT_FILTERS = { from: "", dateFrom: "", dateTo: "", tiers: [] };

/** Higher rank wins — never flicker back to an earlier stage. */
const STATUS_RANK = {
  pending: 0,
  in_progress: 1,
  contacts: 2,
  downloaded: 3,
  failed: 4,
};

function mapDbStatus(att, parentStatus) {
  if (att.status === "error") return "failed";
  if (parentStatus === "extracting" || parentStatus === "pending") {
    // DB attachment may already be "done" while contacts still run
    if (att.status === "done") return "contacts";
    return "in_progress";
  }
  if (att.status === "done" && (parentStatus === "ready_for_validation" || parentStatus === "drafted")) {
    return "downloaded";
  }
  if (att.status === "extracting" || att.status === "pending") return "in_progress";
  if (att.status === "done") return "downloaded";
  return "pending";
}

function canAdvanceStatus(from, to) {
  if (!from) return true;
  if (to === "failed") return true;
  if (from === "failed" && to === "in_progress") return true; // retry
  if (from === "downloaded") return false;
  return (STATUS_RANK[to] ?? 0) >= (STATUS_RANK[from] ?? 0);
}

/**
 * Vessel Extracted Data — All mails + Need to review as tabs (same grid/preview).
 * Review tab filters low/medium / needs_review and hides Fetch Emails.
 */
export default function InboxView({
  onEmailReady,
  onVesselsUpdated,
  onContactsUpdated,
  onEmailsLoaded,
  inboxTab = "all",
  onInboxTabChange,
}) {
  const reviewMode = inboxTab === "review";
  const [emails, setEmails]           = useState([]);
  const [fetching, setFetching]       = useState(false);
  const [fetchDateFrom, setFetchDateFrom] = useState("");
  const [fetchDateTo, setFetchDateTo] = useState("");
  const [retrying, setRetrying]       = useState(false);
  const [jobId, setJobId]             = useState(null);
  const [attStatuses, setAttStatuses] = useState({});
  // Keep a separate open-mail + search per tab — each tab remembers its own selection.
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
  const [liveBusId, setLiveBusId] = useState(null);
  const expectedEmailIdsRef = useRef(new Set());
  const readyEmailIdsRef = useRef(new Set());
  const loadGenRef = useRef(0);

  useEffect(() => { loadEmails(); }, []);

  const attachLiveJob = useCallback((nextJobId) => {
    if (!nextJobId) return;
    setFetching(true);
    setJobId((prev) => (prev === nextJobId ? prev : nextJobId));
  }, []);

  // New Phase-1 job → clear stage map; SSE replay rebuilds it on late attach.
  const lastLiveJobRef = useRef(null);
  useEffect(() => {
    if (!jobId) {
      lastLiveJobRef.current = null;
      return;
    }
    if (lastLiveJobRef.current === jobId) return;
    lastLiveJobRef.current = jobId;
    expectedEmailIdsRef.current = new Set();
    readyEmailIdsRef.current = new Set();
    setAttStatuses({});
  }, [jobId]);

  // AWS: listen for IMAP IDLE auto-fetch and attach the same SSE progress UI.
  // InboxView stays mounted (display:none off-tab), so live progress continues
  // without auto-switching tabs — open Vessel Extracted Data anytime to watch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getRuntimeConfig();
        if (cancelled) return;
        if (cfg?.auto_fetch_imap_idle) {
          setLiveBusId(LIVE_BUS_ID);
        }
        // Resume mid-flight if the page loaded / reconnected after start.
        if (cfg?.active_phase1_job_id) {
          attachLiveJob(cfg.active_phase1_job_id);
        }
      } catch {
        /* local / older API — leave manual fetch only */
      }
    })();
    return () => { cancelled = true; };
  }, [attachLiveJob]);

  useSSE(
    liveBusId,
    useCallback((evt) => {
      if (evt?.type === "auto_fetch_started" && evt.job_id) {
        attachLiveJob(evt.job_id);
      }
    }, [attachLiveJob]),
    undefined,
    { reconnect: true },
  );

  const pickReadyEmail = (data) => {
    const ready = data.find(
      (e) => e.status === "ready_for_validation" || e.status === "drafted"
    );
    if (ready?.id) onEmailReady?.(ready.id);
  };

  const loadEmails = async () => {
    const gen = ++loadGenRef.current;
    try {
      const data = await getEmails();
      if (gen !== loadGenRef.current) return; // ignore stale responses
      // Merge so a racey refresh cannot wipe vessel_count back to 0
      // or drop optimistic in-flight rows before attachment_saved.
      setEmails((prev) => {
        const prevCount = new Map();
        const prevById = new Map(prev.map((em) => [em.id, em]));
        for (const em of prev) {
          for (const att of em.attachments || []) {
            prevCount.set(att.id, att.vessel_count || 0);
          }
        }
        const merged = data.map((em) => {
          const incomingAtts = em.attachments || [];
          if (!incomingAtts.length) {
            const kept = prevById.get(em.id);
            if (kept?.attachments?.length) {
              return { ...em, attachments: kept.attachments, status: em.status || kept.status };
            }
          }
          return {
            ...em,
            attachments: incomingAtts.map((att) => {
              const incoming = att.vessel_count || 0;
              const kept = prevCount.get(att.id) || 0;
              return {
                ...att,
                vessel_count: Math.max(incoming, kept),
              };
            }),
          };
        });
        // Keep optimistic placeholders not yet returned by API.
        const seen = new Set(merged.map((e) => e.id));
        for (const em of prev) {
          if (!seen.has(em.id) && String(em.id) && (em.attachments || []).some((a) => String(a.id).startsWith("pending-"))) {
            merged.unshift(em);
          }
        }
        return merged;
      });
      pickReadyEmail(data);
      onEmailsLoaded?.(data);
    } catch (e) {
      if (gen !== loadGenRef.current) return;
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

  const finishJob = useCallback(() => {
    setFetching(false);
    setRetrying(false);
    setJobId(null);
    setAttStatuses({});
    expectedEmailIdsRef.current = new Set();
    readyEmailIdsRef.current = new Set();
    loadEmails();
  }, []);

  const patchAttachmentMeta = useCallback((attachmentId, patch) => {
    if (!attachmentId) return;
    setEmails((prev) =>
      prev.map((em) => ({
        ...em,
        attachments: (em.attachments || []).map((att) => {
          if (att.id !== attachmentId) return att;
          const next = { ...att, ...patch };
          if (typeof patch.vessel_count === "number") {
            next.vessel_count = Math.max(att.vessel_count || 0, patch.vessel_count);
          }
          return next;
        }),
      }))
    );
  }, []);

  const markAttachments = useCallback((ids, status) => {
    if (!ids?.length) return;
    setAttStatuses((p) => {
      const next = { ...p };
      for (const id of ids) {
        if (canAdvanceStatus(next[id], status)) next[id] = status;
      }
      return next;
    });
  }, []);

  const markOne = useCallback((id, status) => {
    if (!id) return;
    setAttStatuses((p) => {
      if (!canAdvanceStatus(p[id], status)) return p;
      return { ...p, [id]: status };
    });
  }, []);

  const handleEvent = useCallback((evt) => {
    const { type, ...rest } = evt;
    switch (type) {
      case "retry_started":
        markOne(rest.attachment_id, "in_progress");
        break;
      case "ingestion_summary":
        if (Array.isArray(rest.email_ids) && rest.email_ids.length) {
          expectedEmailIdsRef.current = new Set(rest.email_ids);
        }
        break;
      case "email_saved":
        // Show a row immediately (before attachment exists) — stacked one under another.
        if (rest.email_id) {
          expectedEmailIdsRef.current.add(rest.email_id);
          setEmails((prev) => {
            if (prev.some((e) => e.id === rest.email_id)) return prev;
            const placeholderAttId = `pending-${rest.email_id}`;
            return [
              {
                id: rest.email_id,
                subject: rest.subject || "",
                sender: rest.sender || "",
                date_received: rest.date_received || new Date().toISOString(),
                status: "extracting",
                attachments: [
                  {
                    id: placeholderAttId,
                    filename: rest.subject || "Incoming mail…",
                    status: "pending",
                    vessel_count: 0,
                  },
                ],
              },
              ...prev,
            ];
          });
          setAttStatuses((p) => {
            const id = `pending-${rest.email_id}`;
            if (p[id]) return p;
            return { ...p, [id]: "in_progress" };
          });
        }
        loadEmails();
        break;
      case "attachment_saved":
        markOne(rest.attachment_id, "in_progress");
        if (rest.email_id) {
          expectedEmailIdsRef.current.add(rest.email_id);
          // Drop optimistic placeholder once the real attachment id exists.
          setAttStatuses((p) => {
            const next = { ...p };
            delete next[`pending-${rest.email_id}`];
            if (rest.attachment_id) next[rest.attachment_id] = "in_progress";
            return next;
          });
        }
        loadEmails();
        break;
      case "vessels_phase_started":
      case "extraction_started":
        markOne(rest.attachment_id, "in_progress");
        if (Array.isArray(rest.email_ids) && rest.email_ids.length) {
          expectedEmailIdsRef.current = new Set(rest.email_ids);
        }
        break;
      case "extraction_done": {
        // Vessels done for this mail — keep "Extracting vessels" until contacts phase starts
        const vc = rest.vessel_count;
        patchAttachmentMeta(rest.attachment_id, {
          status: "done",
          ...(typeof vc === "number" ? { vessel_count: vc } : {}),
        });
        break;
      }
      case "all_extractions_done":
      case "contacts_phase_started":
        if (Array.isArray(rest.email_ids) && rest.email_ids.length) {
          expectedEmailIdsRef.current = new Set(rest.email_ids);
        }
        setAttStatuses((p) => {
          const next = { ...p };
          // Promote every known attachment into contacts stage (not Synced yet)
          const ids = new Set([
            ...Object.keys(next),
            ...(rest.attachment_ids || []),
          ]);
          for (const id of ids) {
            const st = next[id] || "in_progress";
            if (st !== "failed" && st !== "downloaded" && canAdvanceStatus(st, "contacts")) {
              next[id] = "contacts";
            }
          }
          return next;
        });
        loadEmails(); // now safe — all vessels should be in DB
        break;
      case "email_contacts_started":
      case "signature_attachment_started":
      case "contact_attachment_started":
        if (rest.attachment_ids?.length) {
          markAttachments(rest.attachment_ids, "contacts");
        } else {
          markOne(rest.attachment_id, "contacts");
        }
        break;
      case "extraction_error":
        markOne(rest.attachment_id, "failed");
        break;
      case "email_ready":
        // Synced for this mail only — spinner keeps going until phase1_complete
        markAttachments(rest.attachment_ids || [], "downloaded");
        if (rest.email_id) readyEmailIdsRef.current.add(rest.email_id);
        loadEmails();
        onContactsUpdated?.();
        if (rest.email_id) onEmailReady?.(rest.email_id);
        break;
      case "attachment_auto_verified":
        // Don't spam vessel list reloads mid-fetch
        break;
      case "phase1_complete":
        if (rest.email_id) onEmailReady?.(rest.email_id);
        onVesselsUpdated?.();
        onContactsUpdated?.();
        finishJob();
        break;
      case "phase1_no_new":
        // Date scope may still have updated — refresh Home summary.
        onVesselsUpdated?.();
        finishJob();
        break;
      case "retry_no_work":
      case "phase1_failed":
        finishJob();
        break;
      default:
        break;
    }
  }, [
    onEmailReady,
    onVesselsUpdated,
    onContactsUpdated,
    finishJob,
    markAttachments,
    markOne,
    patchAttachmentMeta,
  ]);

  useSSE(jobId, handleEvent, undefined, { reconnect: true });

  // Safety net while a job is live: refresh list if an SSE event was missed.
  useEffect(() => {
    if (!jobId) return undefined;
    const t = setInterval(() => { loadEmails(); }, 4000);
    return () => clearInterval(t);
  }, [jobId]);

  const handleFetch = async () => {
    if (!fetchDateFrom && !fetchDateTo) {
      alert("Pick a fetch date range first, then click Fetch Emails.");
      return;
    }
    setFetching(true);
    expectedEmailIdsRef.current = new Set();
    readyEmailIdsRef.current = new Set();
    setAttStatuses({});
    try {
      const { job_id } = await fetchEmails({
        date_from: fetchDateFrom || null,
        date_to: fetchDateTo || null,
      });
      setJobId(job_id);
    } catch (e) {
      setFetching(false);
      alert("Failed to start fetch: " + e.message);
    }
  };

  const handleRetry = async () => {
    if (!retryTarget?.emailId) return;
    setRetrying(true);
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

  const resolveAttStatus = (att) => {
    if (attStatuses[att.id]) return attStatuses[att.id];
    return mapDbStatus(att, att.email?.status);
  };

  const isOpenable = (status) => status === "downloaded" || status === "failed";

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

  // Review tab: same rule as Home dashboard (needs_review flag from API).
  const isReviewRow = useCallback((r) => {
    if (r.is_verified) return false;
    if (typeof r.needs_review === "boolean") return r.needs_review;
    const tier = r.confidence_tier;
    return tier === "medium" || tier === "low" || resolveAttStatus(r) === "failed";
  }, [attStatuses]);

  const reviewRows = useMemo(
    () => mailRows.filter(isReviewRow),
    [mailRows, isReviewRow]
  );

  const scopedRows = useMemo(
    () => (reviewMode ? reviewRows : mailRows),
    [reviewMode, reviewRows, mailRows]
  );

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
      return true;
    });
  }, [scopedRows, search, filters]);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.from.trim()) n += 1;
    if (filters.dateFrom || filters.dateTo) n += 1;
    if (filters.tiers.length) n += 1;
    return n;
  }, [filters]);

  // Header KPIs stay global (all mails) so tab switches don't resize the header.
  const inboxStats = useMemo(() => {
    let downloaded = 0;
    let vessels = 0;
    for (const row of mailRows) {
      if (resolveAttStatus(row) === "downloaded") downloaded += 1;
      vessels += row.vessel_count || 0;
    }
    return {
      emails: emails.length,
      downloaded,
      vessels,
    };
  }, [mailRows, emails, attStatuses]);

  // Retry control: count across all mails so the header action doesn't appear/disappear per tab.
  const retryTarget = useMemo(() => {
    for (const em of emails) {
      const count = (em.attachments || []).filter((att) => isRetryableAtt(att)).length;
      if (count > 0) return { emailId: em.id, count };
    }
    return null;
  }, [emails, attStatuses]);

  const selectedRow = useMemo(
    () => mailRows.find((r) => r.id === selectedId) || null,
    [mailRows, selectedId]
  );

  // Close preview if selected mail is no longer openable (still downloading)
  useEffect(() => {
    if (!selectedRow) return;
    if (!isOpenable(resolveAttStatus(selectedRow))) {
      setSelectedId(null);
    }
  }, [selectedRow, attStatuses, emails]);

  return (
    <div className="vgrid-root">

      <div className="vgrid-head">
        <div className="vgrid-title">
          <div className="vgrid-title-row">
            <h2>Vessel Extracted Data</h2>
            {emails.length > 0 && (
              <div className="vgrid-stats inline">
                <InboxStat label="Emails" value={inboxStats.emails} />
                <InboxStat label="Synced" value={inboxStats.downloaded} />
                <InboxStat label="Vessels" value={inboxStats.vessels} />
              </div>
            )}
          </div>
        </div>
        <div className="vgrid-actions inbox-head-actions">
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
          ) : (
            <span className="inbox-retry-slot" aria-hidden="true" />
          )}
          {!reviewMode && (
            <div className="inbox-fetch-dates">
              <DateRangePicker
                from={fetchDateFrom}
                to={fetchDateTo}
                onChange={({ from: f, to: t }) => {
                  setFetchDateFrom(f);
                  setFetchDateTo(t);
                }}
              />
            </div>
          )}
          <button
            type="button"
            onClick={handleFetch}
            disabled={reviewMode || fetchBusy || anyJobActive || (!fetchDateFrom && !fetchDateTo)}
            className={`btn btn-send inbox-fetch-btn ${reviewMode ? "is-placeholder" : ""}`}
            aria-hidden={reviewMode}
            tabIndex={reviewMode ? -1 : undefined}
            title={
              reviewMode
                ? undefined
                : !fetchDateFrom && !fetchDateTo
                  ? "Select a date range, then fetch"
                  : fetchBusy || anyJobActive
                    ? "Fetching emails…"
                    : "Fetch broker emails in the selected date range"
            }
          >
            {(fetchBusy || (anyJobActive && fetching)) && !reviewMode && (
              <span className="spin-ring" style={{ width: 14, height: 14 }} />
            )}
            Fetch Emails
          </button>
        </div>
      </div>

      <div className="inbox-tabs" role="tablist" aria-label="Extracted mail views">
        <button
          type="button"
          role="tab"
          aria-selected={!reviewMode}
          className={`inbox-tab ${!reviewMode ? "active" : ""}`}
          onClick={() => onInboxTabChange?.("all")}
        >
          <Icon name="mail" size={14} />
          All mails ({mailRows.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={reviewMode}
          className={`inbox-tab ${reviewMode ? "active" : ""}`}
          onClick={() => onInboxTabChange?.("review")}
        >
          <Icon name="alert" size={14} />
          Need to review ({reviewRows.length})
        </button>
      </div>
      <p className="inbox-tab-hint">
        {reviewMode
          ? "Please review the medium & low confidence mails."
          : "Owner position emails, parsed automatically — open a mail to check vessels."}
      </p>

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
                {fetchBusy
                  ? "Fetching…"
                  : reviewMode
                    ? "Nothing to review \uD83C\uDF89"
                    : "No emails fetched yet. Click \u201CFetch Emails\u201D to start."}
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
                const openable = isOpenable(status);
                const sender = row.email.sender || "—";
                const avColor = AV_COLORS[(sender.charCodeAt(0) || 0) % AV_COLORS.length];
                const fileLabel = String(row.filename || "").trim();
                const subject = String(row.email.subject || "").trim();
                const showFile =
                  Boolean(fileLabel)
                  && !/^subject:\s*/i.test(fileLabel)
                  && fileLabel.toLowerCase() !== subject.toLowerCase();
                return (
                  <div
                    key={row.id}
                    role="button"
                    tabIndex={openable ? 0 : -1}
                    aria-disabled={!openable}
                    className={`imail-card ${selectedId === row.id ? "active" : ""} ${status === "failed" ? "is-failed" : ""} ${!openable ? "is-locked" : ""}`}
                    title={
                      !openable
                        ? status === "contacts"
                          ? "Vessels finished — still extracting contacts. Opens when Synced."
                          : "Still extracting vessels — opens when Synced"
                        : undefined
                    }
                    onClick={() => {
                      if (!openable) return;
                      setSelectedId(row.id);
                    }}
                    onKeyDown={(e) => {
                      if (!openable) return;
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
                    {showFile && (
                      <div className="imail-file" title={fileLabel}>
                        <Icon name="clip" size={12} />
                        <span>{fileLabel}</span>
                      </div>
                    )}
                    <div className="imail-badges">
                      <StatusBadge status={status} />
                      {status === "downloaded" && (
                        <span
                          className={`imail-verified ${row.is_verified ? "is-on" : ""}`}
                          title={row.is_verified ? "On Vessel Position List" : "Not on Vessel Position List"}
                        >
                          {row.is_verified ? "Verified" : "Not verified"}
                        </span>
                      )}
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
                      <VesselCountBadge count={row.vessel_count} status={status} />
                      <ConfidenceBadge
                        score={row.confidence_score}
                        tier={row.confidence_tier}
                        label={row.confidence_label}
                        status={status}
                        reviewed={Boolean(row.manually_reviewed)}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── Right: detail pane ── */}
        <div className="inbox-detail">
          {selectedRow && isOpenable(resolveAttStatus(selectedRow)) ? (
            <PreviewPanel
              key={selectedRow.id}
              attachmentId={selectedRow.id}
              filename={selectedRow.filename}
              emailId={selectedRow.email.id}
              initialVerified={Boolean(selectedRow.is_verified)}
              vesselCount={selectedRow.vessel_count || 0}
              showVerify
              showEdit
              onVerifiedChange={(isVerified) => {
                patchAttachmentVerified(selectedRow.id, isVerified);
                onVesselsUpdated?.();
                loadEmails();
              }}
              onDataChange={() => {
                loadEmails();
                onVesselsUpdated?.();
              }}
            />
          ) : (
            <div className="inbox-detail-empty">
              <div className="ide-icon"><Icon name="mail" size={34} /></div>
              <div>
                {fetchBusy || anyJobActive
                  ? "Mails appear as they arrive. Open a mail only when it shows Synced."
                  : "Select a mail on the left to preview its extracted vessels and original message."}
              </div>
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
          <DateRangePicker
            from={dateFrom}
            to={dateTo}
            onChange={({ from: f, to: t }) => {
              setDateFrom(f);
              setDateTo(t);
            }}
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

      <div className="iflt-btns">
        <button type="button" className="tb-btn" onClick={onClear}>Clear</button>
        <button
          type="button"
          className="tb-btn tb-btn-primary"
          onClick={() => onApply({ from, dateFrom, dateTo, tiers })}
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

function VesselCountBadge({ count, status }) {
  const n = count ?? 0;
  // Hide only while still extracting vessels with no count yet
  if ((status === "in_progress" || status === "pending") && n === 0) return null;
  return (
    <span className="imail-vcount" title="Vessels extracted from this mail">
      {n} vessel{n !== 1 ? "s" : ""}
    </span>
  );
}

function ConfidenceBadge({ score, tier, label, status, reviewed = false }) {
  if (
    status === "in_progress"
    || status === "pending"
    || status === "contacts"
    || tier === "unknown"
    || score == null
  ) {
    if (status === "contacts") {
      return <span className="cell-val is-empty" title="Score available when Synced">—</span>;
    }
    return <span className="cell-val is-empty" title="Score available after extraction">—</span>;
  }

  const band = tier === "high" ? "hi" : tier === "medium" ? "mid" : "lo";
  const triageHint =
    tier === "high"
      ? "auto-added to Position List"
      : tier === "medium"
        ? "review recommended"
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
    in_progress: { label: "Extracting vessels", cls: "st-proc", spin: true },
    contacts:    { label: "Extracting contacts", cls: "st-contacts", spin: true },
    downloaded:  { label: "Synced", cls: "st-auto", spin: false },
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
