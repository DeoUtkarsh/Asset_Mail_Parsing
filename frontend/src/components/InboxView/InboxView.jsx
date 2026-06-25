import { useState, useEffect, useCallback, useMemo } from "react";
import { fetchEmails, getEmails, retryExtraction } from "../../services/api";
import { useSSE } from "../../hooks/useSSE";
import PreviewModal from "./PreviewModal";

export default function InboxView({ onEmailReady, onVesselsUpdated }) {
  const [emails, setEmails]           = useState([]);
  const [fetching, setFetching]       = useState(false);
  const [retrying, setRetrying]       = useState(false);
  const [jobId, setJobId]             = useState(null);
  const [statusLog, setStatusLog]     = useState([]);
  const [previewAtt, setPreviewAtt]   = useState(null);
  const [attStatuses, setAttStatuses] = useState({});

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

  const isRetryableStatus = (status) =>
    status === "error" || status === "pending" || status === "extracting";

  const retryTarget = useMemo(() => {
    for (const em of emails) {
      const count = (em.attachments || []).filter((att) =>
        isRetryableStatus(attStatuses[att.id] || att.status)
      ).length;
      if (count > 0) return { emailId: em.id, count };
    }
    return null;
  }, [emails, attStatuses]);

  const handleEvent = useCallback((evt) => {
    const { type, ...rest } = evt;
    setStatusLog((prev) => [{ type, ...rest, ts: Date.now() }, ...prev].slice(0, 50));
    switch (type) {
      case "email_saved":       loadEmails(); break;
      case "attachment_saved":  setAttStatuses((p) => ({ ...p, [rest.attachment_id]: "pending" })); break;
      case "extraction_started":setAttStatuses((p) => ({ ...p, [rest.attachment_id]: "extracting" })); break;
      case "extraction_done":
      case "extraction_error":
        setAttStatuses((p) => ({ ...p, [rest.attachment_id]: type === "extraction_done" ? "done" : "error" }));
        break;
      case "phase1_complete":
        setFetching(false);
        setRetrying(false);
        setJobId(null);
        if (rest.email_id) onEmailReady?.(rest.email_id);
        onVesselsUpdated?.();
        loadEmails();
        break;
      case "phase1_no_new":
        setFetching(false);
        setJobId(null);
        loadEmails();
        break;
      case "retry_no_work":
        setRetrying(false);
        setJobId(null);
        loadEmails();
        break;
      case "phase1_failed":
        setFetching(false);
        setRetrying(false);
        setJobId(null);
        break;
      case "signature_extraction_started":
      case "signature_extraction_done":
      case "signature_extraction_error":
        if (type === "signature_extraction_done") loadEmails();
        break;
      default: break;
    }
  }, [onEmailReady, onVesselsUpdated]);

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

  const busy = fetching || retrying;

  const resolveAttStatus = (att) => attStatuses[att.id] || att.status;

  const rows = emails.flatMap((em) =>
    (em.attachments || []).map((att) => ({ ...att, email: em }))
  );

  const fmtDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="flex flex-col h-full" style={{ background: "#f0f9ff" }}>

      {/* ── Top bar — deep ocean ──────────────────────────────── */}
      <div
        className="flex items-center justify-between px-6 py-4 flex-shrink-0 shadow-md"
        style={{ background: "linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%)" }}
      >
        <div>
          <h1 className="text-base font-bold text-white tracking-wide">Vessel Extracted Data</h1>
        </div>
        <div className="flex items-center gap-3">
          {retryTarget ? (
            <button
              onClick={handleRetry}
              disabled={busy}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium transition-all shadow-sm bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-amber-600"
            >
              {retrying ? (
                <>
                  <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Retrying…
                </>
              ) : (
                `Retry Failed (${retryTarget.count})`
              )}
            </button>
          ) : null}
          <button
            onClick={handleFetch}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium transition-all shadow-sm bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-sky-600"
          >
            {fetching ? (
              <>
                <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Fetching…
              </>
            ) : (
              "Fetch Emails"
            )}
          </button>
        </div>
      </div>

      {/* ── Status log ──────────────────────────────────────────── */}
      {statusLog.length > 0 && (
        <div
          className="mx-6 mt-3 rounded-lg p-3 max-h-28 overflow-y-auto font-mono text-xs shadow-sm flex-shrink-0"
          style={{ background: "#e0f2fe", border: "1px solid #bae6fd", color: "#0c4a6e" }}
        >
          {statusLog.map((log, i) => (
            <div key={i} className="leading-5">
              <span style={{ color: "#7dd3fc" }}>[{log.type}]</span>{" "}
              {log.filename && <span style={{ color: "#0369a1" }}>{log.filename}</span>}
              {log.message && <span> {log.message}</span>}
              {log.signature_preview != null && log.signature_preview !== "" && (
                <span style={{ color: "#0369a1" }}> {log.signature_preview}</span>
              )}
              {log.error && <span style={{ color: "#b91c1c" }}> {log.error}</span>}
              {log.vessel_count !== undefined && (
                <span style={{ color: "#0891b2" }}> → {log.vessel_count} vessels</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Table ───────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-auto px-6 py-4">
        {rows.length === 0 && !busy ? (
          <div
            className="rounded-xl p-16 text-center text-sm"
            style={{ background: "#fff", border: "2px dashed #bae6fd", color: "#7dd3fc" }}
          >
            No emails fetched yet. Click "Fetch Emails" to start.
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden shadow-md" style={{ border: "1px solid #bae6fd" }}>
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10">
                <tr style={{ background: "#0369a1" }}>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide w-28"
                      style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}>Date</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide w-16"
                      style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}>Time</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide"
                      style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}>Sender</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide"
                      style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}
                      title="Name from the email (Content-Disposition / MIME); re-fetch to refresh old rows">
                    Attachment name
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide w-32"
                      style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}>Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide w-44"
                      style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const status = resolveAttStatus(row);

                  return (
                    <tr
                      key={row.id}
                      style={{
                        background: i % 2 === 0 ? "#ffffff" : "#f0f9ff",
                        borderBottom: "1px solid #e0f2fe",
                        transition: "background 0.15s",
                        cursor: "default",
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = "#e0f2fe"}
                      onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? "#ffffff" : "#f0f9ff"}
                    >
                      {/* Date */}
                      <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: "#0c4a6e" }}>
                        {fmtDate(row.email.date_received)}
                      </td>

                      {/* Time */}
                      <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: "#7dd3fc" }}>
                        {fmtTime(row.email.date_received)}
                      </td>

                      {/* Sender */}
                      <td className="px-4 py-3 text-xs max-w-[200px]">
                        <div className="truncate font-semibold" style={{ color: "#0c4a6e" }} title={row.email.sender}>
                          {row.email.sender}
                        </div>
                        <div className="truncate text-[11px] mt-0.5" style={{ color: "#7dd3fc" }} title={row.email.subject}>
                          {row.email.subject}
                        </div>
                      </td>

                      <td className="px-4 py-3 max-w-[min(28rem,40vw)]">
                        <span
                          className="flex items-center gap-1.5 text-xs font-mono w-full min-w-0"
                          style={{ color: "#0369a1" }}
                          title={row.filename || undefined}
                        >
                          <span className="flex-shrink-0" style={{ color: "#7dd3fc" }}>📎</span>
                          <span className="truncate">{row.filename || "—"}</span>
                        </span>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <StatusBadge status={status} />
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {(status === "done" || status === "extracting") && (
                            <button
                              onClick={() =>
                                setPreviewAtt({ id: row.id, filename: row.filename, emailId: row.email.id })
                              }
                              className="px-3 py-1 rounded-lg text-xs font-medium transition-colors shadow-sm"
                              style={{ background: "#fff", border: "1px solid #bae6fd", color: "#0369a1" }}
                              onMouseEnter={e => e.currentTarget.style.background = "#e0f2fe"}
                              onMouseLeave={e => e.currentTarget.style.background = "#fff"}
                            >
                              Preview
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {previewAtt && (
        <PreviewModal
          attachmentId={previewAtt.id}
          filename={previewAtt.filename}
          emailId={previewAtt.emailId}
          onClose={() => setPreviewAtt(null)}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    pending:              { bg: "#f0f9ff", color: "#7dd3fc", border: "#bae6fd" },
    extracting:           { bg: "#fffbeb", color: "#d97706", border: "#fcd34d", pulse: true },
    done:                 { bg: "#ecfeff", color: "#0891b2", border: "#a5f3fc" },
    error:                { bg: "#fef2f2", color: "#dc2626", border: "#fca5a5" },
    ready_for_validation: { bg: "#e0f2fe", color: "#0369a1", border: "#7dd3fc" },
    drafted:              { bg: "#f5f3ff", color: "#7c3aed", border: "#c4b5fd" },
  };
  const s = map[status] || map.pending;
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap ${s.pulse ? "animate-pulse" : ""}`}
      style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}
    >
      {status?.replace(/_/g, " ") || "pending"}
    </span>
  );
}
