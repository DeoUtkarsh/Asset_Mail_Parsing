import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import {
  fetchEmails,
  getEmails,
  retryExtraction,
  retryAttachment,
  setAttachmentVerified,
} from "../../services/api";
import { useSSE } from "../../hooks/useSSE";
import PreviewModal from "./PreviewModal";
import VerifyButton from "./VerifyButton";
import AiSummaryButton from "../AiSummary/AiSummaryButton";
import { summarizeInbox } from "../../services/api";
import Icon from "../icons";

function mapDbStatus(status) {
  if (status === "done") return "downloaded";
  if (status === "error") return "failed";
  if (status === "extracting" || status === "pending") return "in_progress";
  return status;
}

function canVerifyAttachment(att, uiStatus) {
  return uiStatus === "downloaded" && (att.vessel_count || 0) >= 1;
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

  const inboxStats = useMemo(() => {
    let attachments = 0;
    let downloaded = 0;
    let verified = 0;
    let vessels = 0;
    for (const em of emails) {
      for (const att of em.attachments || []) {
        attachments += 1;
        if (resolveAttStatus(att) === "downloaded") downloaded += 1;
        if (att.is_verified) verified += 1;
        vessels += att.vessel_count || 0;
      }
    }
    return { emails: emails.length, attachments, downloaded, verified, vessels };
  }, [emails, attStatuses]);

  const fmtDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="vgrid-root">

      <div className="vgrid-head">
        <h2>Vessel Extracted Data</h2>
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

      <div className="vgrid-body">
        {groupedEmails.length === 0 && !fetchBusy ? (
          <div className="vessel-grid-empty">
            No emails fetched yet. Click &quot;Fetch Emails&quot; to start.
          </div>
        ) : (
          <div className="vessel-grid-wrap">
            <div className="vessel-grid-scroll">
              <table className="vessel-grid inbox-grid">
                <thead>
                  <tr>
                    <th className="col-date">Date</th>
                    <th className="col-time">Time</th>
                    <th>Sender</th>
                    <th title="Name from the email (Content-Disposition / MIME); re-fetch to refresh old rows">
                      Attachment name
                    </th>
                    <th className="col-status">Status</th>
                    <th className="col-actions">Actions</th>
                    <th className="col-conf" title="Pipeline quality score — review Low before verifying">
                      Confidence
                    </th>
                    <th className="col-verify">Verified</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedEmails.map((em) => {
                    const attachments = em.attachments || [];
                    const doneCount = attachments.filter(
                      (att) => resolveAttStatus(att) === "downloaded"
                    ).length;
                    const verifiedCount = attachments.filter((att) => att.is_verified).length;

                    return (
                      <Fragment key={em.id}>
                        <tr className="grp-row">
                          <td colSpan={8}>
                            <div className="grp-label">
                              <span className="grp-icon"><Icon name="mail" size={14} /></span>
                              <span>{fmtDate(em.date_received)} {fmtTime(em.date_received)}</span>
                              <span title={em.sender}>{em.sender}</span>
                              <span className="grp-subj" title={em.subject}>{em.subject}</span>
                              <span className="inbox-grp-meta">
                                {doneCount}/{attachments.length} downloaded
                                {verifiedCount > 0 && (
                                  <span className="hi"> · {verifiedCount} verified</span>
                                )}
                              </span>
                            </div>
                          </td>
                        </tr>
                        {attachments.map((att) => {
                          const row = { ...att, email: em };
                          const status = resolveAttStatus(row);
                          const previewReady = status === "downloaded";
                          const verified = Boolean(row.is_verified);
                          const verifyReady = canVerifyAttachment(row, status);
                          const verifyBusy = verifyBusyId === row.id;

                          return (
                            <tr key={row.id}>
                              <td className="cell-date">{fmtDate(row.email.date_received)}</td>
                              <td className="cell-time">{fmtTime(row.email.date_received)}</td>
                              <td className="cell-sender">
                                <div className="owner" title={row.email.sender}>{row.email.sender}</div>
                                <div className="subj" title={row.email.subject}>{row.email.subject}</div>
                              </td>
                              <td className="cell-file">
                                <span className="file-name" title={row.filename || undefined}>
                                  <Icon name="clip" size={13} />
                                  <span>{row.filename || "—"}</span>
                                </span>
                              </td>
                              <td><StatusBadge status={status} /></td>
                              <td>
                                <div className="inbox-actions">
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
                                    className="inbox-btn"
                                  >
                                    Preview
                                  </button>
                                  {status === "failed" && (
                                    <button
                                      type="button"
                                      onClick={() => handleRetryAttachment(row.id)}
                                      disabled={anyJobActive}
                                      className="inbox-btn inbox-btn-danger"
                                    >
                                      Retry
                                    </button>
                                  )}
                                </div>
                              </td>
                              <td>
                                <ConfidenceBadge
                                  score={row.confidence_score}
                                  tier={row.confidence_tier}
                                  label={row.confidence_label}
                                  status={status}
                                  reviewed={Boolean(row.manually_reviewed)}
                                />
                              </td>
                              <td>
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
          onDataChange={() => {
            loadEmails();
            onVesselsUpdated?.();
          }}
          onClose={() => setPreviewAtt(null)}
        />
      )}
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
