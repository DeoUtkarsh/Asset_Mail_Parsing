import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import {
  fetchEmails,
  getEmails,
  retryExtraction,
  retryAttachment,
  setAttachmentVerified,
  verifyAllAttachments,
  verifyEmailAttachments,
} from "../../services/api";
import { useSSE } from "../../hooks/useSSE";
import PreviewModal from "./PreviewModal";
import VerifyButton from "./VerifyButton";
import VerifyAllButton from "./VerifyAllButton";
import AiSummaryButton from "../AiSummary/AiSummaryButton";
import { summarizeInbox } from "../../services/api";

function mapDbStatus(status) {
  if (status === "done") return "downloaded";
  if (status === "error") return "failed";
  if (status === "extracting" || status === "pending") return "in_progress";
  return status;
}

function canVerifyAttachment(att, uiStatus) {
  return uiStatus === "downloaded" && (att.vessel_count || 0) >= 1;
}

function countEligibleToVerify(attachments, resolveStatus) {
  return (attachments || []).filter((att) => {
    const status = resolveStatus(att);
    return canVerifyAttachment(att, status) && !att.is_verified;
  }).length;
}

export default function InboxView({ onEmailReady, onVesselsUpdated, onContactsUpdated }) {
  const [emails, setEmails]           = useState([]);
  const [fetching, setFetching]       = useState(false);
  const [retrying, setRetrying]       = useState(false);
  const [jobId, setJobId]             = useState(null);
  const [statusLog, setStatusLog]     = useState([]);
  const [previewAtt, setPreviewAtt]   = useState(null);
  const [attStatuses, setAttStatuses] = useState({});
  const [verifyBusyId, setVerifyBusyId] = useState(null);

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
    setPreviewAtt((p) => (p?.id === attId ? { ...p, isVerified } : p));
  }, []);

  const handleVerifyAttachment = async (attId, verified) => {
    setVerifyBusyId(attId);
    try {
      const result = await setAttachmentVerified(attId, verified);
      patchAttachmentVerified(attId, Boolean(result.is_verified));
      onVesselsUpdated?.();
      // Reconcile with server but keep stable attachment order (created_at)
      await loadEmails();
    } catch (e) {
      await loadEmails();
      alert("Verify failed: " + e.message);
    } finally {
      setVerifyBusyId(null);
    }
  };

  const handleVerifyAllGlobal = async () => {
    try {
      const result = await verifyAllAttachments();
      await loadEmails();
      onVesselsUpdated?.();
      if (!result.verified_count) {
        alert("No attachments eligible to verify (need downloaded + at least 1 vessel).");
      }
    } catch (e) {
      alert("Verify all failed: " + e.message);
    }
  };

  const handleVerifyAllEmail = async (emailId) => {
    try {
      const result = await verifyEmailAttachments(emailId);
      await loadEmails();
      onVesselsUpdated?.();
      if (!result.verified_count) {
        alert("No attachments eligible to verify in this email.");
      }
    } catch (e) {
      alert("Verify all failed: " + e.message);
    }
  };

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

  const groupedEmails = emails
    .slice()
    .sort((a, b) => new Date(b.date_received) - new Date(a.date_received));

  const globalEligibleVerify = useMemo(
    () => groupedEmails.reduce(
      (sum, em) => sum + countEligibleToVerify(em.attachments, (att) => {
        if (attStatuses[att.id]) return attStatuses[att.id];
        return mapDbStatus(att.status);
      }),
      0,
    ),
    [groupedEmails, attStatuses],
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

      <div
        className="flex items-center justify-between px-6 py-4 flex-shrink-0 shadow-md"
        style={{ background: "linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%)" }}
      >
        <div>
          <h1 className="text-base font-bold text-white tracking-wide">Vessel Extracted Data</h1>
        </div>
        <div className="flex items-center gap-3">
          {retryTarget && !anyJobActive ? (
            <button
              onClick={handleRetry}
              disabled={retrying || anyJobActive}
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
          <AiSummaryButton
            fetchSummary={fetchInboxSummary}
            title="Email Data — AI Summary"
            disabled={emails.length === 0 || anyJobActive}
          />
          <button
            onClick={handleFetch}
            disabled={fetchBusy || anyJobActive}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium transition-all shadow-sm bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-sky-600"
          >
            {fetchBusy ? (
              <>
                <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Fetch in progress…
              </>
            ) : (
              "Fetch Emails"
            )}
          </button>
        </div>
      </div>

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

      <div className="flex-1 min-h-0 overflow-auto px-6 py-4">
        {groupedEmails.length === 0 && !fetchBusy ? (
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
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide w-40"
                      style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}>Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide w-44"
                      style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}>Actions</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide w-36"
                      style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}>
                    <div className="flex flex-col items-start gap-1.5">
                      <span>Verified</span>
                      <VerifyAllButton
                        label="Verify All Attachments"
                        disabled={globalEligibleVerify === 0 || anyJobActive}
                        onClick={handleVerifyAllGlobal}
                      />
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {groupedEmails.map((em) => {
                  const attachments = em.attachments || [];
                  const doneCount = attachments.filter(
                    (att) => resolveAttStatus(att) === "downloaded"
                  ).length;
                  const emailEligibleVerify = countEligibleToVerify(
                    attachments,
                    (att) => resolveAttStatus({ ...att, email: em }),
                  );
                  const verifiedCount = attachments.filter((att) => att.is_verified).length;

                  return (
                    <Fragment key={em.id}>
                      <tr style={{ background: "#e0f2fe", borderBottom: "2px solid #7dd3fc" }}>
                        <td colSpan={6} className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                            <span className="font-bold" style={{ color: "#0c4a6e" }}>
                              {fmtDate(em.date_received)} {fmtTime(em.date_received)}
                            </span>
                            <span className="font-semibold truncate max-w-[220px]" style={{ color: "#0369a1" }} title={em.sender}>
                              {em.sender}
                            </span>
                            <span className="truncate flex-1 min-w-0" style={{ color: "#0c4a6e" }} title={em.subject}>
                              {em.subject}
                            </span>
                            <span className="font-medium whitespace-nowrap" style={{ color: "#0891b2" }}>
                              {doneCount}/{attachments.length} downloaded
                              {verifiedCount > 0 && (
                                <span style={{ color: "#16a34a" }}> · {verifiedCount} verified</span>
                              )}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 align-middle">
                          <VerifyAllButton
                            label="Verify all in email"
                            disabled={emailEligibleVerify === 0 || anyJobActive}
                            onClick={() => handleVerifyAllEmail(em.id)}
                          />
                        </td>
                      </tr>
                      {attachments.map((att, i) => {
                        const row = { ...att, email: em };
                        const status = resolveAttStatus(row);
                        const previewReady = status === "downloaded";
                        const verified = Boolean(row.is_verified);
                        const verifyReady = canVerifyAttachment(row, status);
                        const verifyBusy = verifyBusyId === row.id;

                        return (
                          <tr
                            key={row.id}
                            style={{
                              background: i % 2 === 0 ? "#ffffff" : "#f0f9ff",
                              borderBottom: "1px solid #e0f2fe",
                              transition: "background 0.15s",
                              cursor: "default",
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = "#e0f2fe"; }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = i % 2 === 0 ? "#ffffff" : "#f0f9ff";
                            }}
                          >
                            <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: "#0c4a6e" }}>
                              {fmtDate(row.email.date_received)}
                            </td>
                            <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: "#7dd3fc" }}>
                              {fmtTime(row.email.date_received)}
                            </td>
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
                            <td className="px-4 py-3">
                              <StatusBadge status={status} />
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={!previewReady}
                                  onClick={() =>
                                    previewReady &&
                                    setPreviewAtt({
                                      id: row.id,
                                      filename: row.filename,
                                      emailId: row.email.id,
                                      isVerified: verified,
                                      vesselCount: row.vessel_count || 0,
                                    })
                                  }
                                  className="px-3 py-1 rounded-lg text-xs font-medium transition-colors shadow-sm disabled:opacity-45 disabled:cursor-not-allowed"
                                  style={{
                                    background: previewReady ? "#fff" : "#f8fafc",
                                    border: `1px solid ${previewReady ? "#bae6fd" : "#e2e8f0"}`,
                                    color: previewReady ? "#0369a1" : "#94a3b8",
                                  }}
                                  onMouseEnter={(e) => {
                                    if (previewReady) e.currentTarget.style.background = "#e0f2fe";
                                  }}
                                  onMouseLeave={(e) => {
                                    if (previewReady) e.currentTarget.style.background = "#fff";
                                  }}
                                >
                                  Preview
                                </button>
                                {status === "failed" && (
                                  <button
                                    onClick={() => handleRetryAttachment(row.id)}
                                    disabled={anyJobActive}
                                    className="px-3 py-1 rounded-lg text-xs font-medium transition-colors shadow-sm disabled:opacity-40"
                                    style={{ background: "#fff", border: "1px solid #fca5a5", color: "#dc2626" }}
                                  >
                                    Retry
                                  </button>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <VerifyButton
                                verified={verified}
                                canVerify={verifyReady}
                                busy={verifyBusy}
                                onToggle={() => handleVerifyAttachment(row.id, !verified)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
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
          initialVerified={previewAtt.isVerified}
          vesselCount={previewAtt.vesselCount}
          onVerifiedChange={() => {
            loadEmails();
            onVesselsUpdated?.();
          }}
          onClose={() => setPreviewAtt(null)}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    in_progress: { label: "In Progress", bg: "#fffbeb", color: "#d97706", border: "#fcd34d", spin: true },
    downloaded:  { label: "Downloaded", bg: "#ecfeff", color: "#0891b2", border: "#a5f3fc", spin: false },
    failed:      { label: "Failed", bg: "#fef2f2", color: "#dc2626", border: "#fca5a5", spin: false },
    pending:     { label: "Pending", bg: "#f0f9ff", color: "#7dd3fc", border: "#bae6fd", spin: false },
  };
  const s = map[status] || map.pending;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}
    >
      {s.spin && (
        <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
      )}
      {s.label}
    </span>
  );
}
