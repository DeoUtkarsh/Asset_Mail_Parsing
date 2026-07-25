import { useState, useEffect, useCallback } from "react";
import { getAttachmentRaw, attachmentFileUrl, setAttachmentVerified } from "../../services/api";
import { vesselName, needsReview, regionUnknown } from "../../lib/positions";
import { sanitizeEmailHtml, resolvePreviewMode } from "../../utils/emailPreview";
import Icon from "../icons";
import PdfView from "../PdfView";
import PreviewModal from "../InboxView/PreviewModal";
import VerifyButton from "../InboxView/VerifyButton";

const pick = (d, keys) => { for (const k of keys) if (d[k]) return d[k]; return null; };
const AV = ["#219495", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#10b981", "#ec4899", "#0ea5e9"];
const fmtSize = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : n > 1e3 ? Math.round(n / 1e3) + " KB" : n + " B");
const shortType = (ct = "") => {
  if (ct.includes("pdf")) return "PDF";
  if (ct.startsWith("image/")) return ct.split("/")[1].toUpperCase();
  if (ct.includes("sheet") || ct.includes("excel")) return "XLSX";
  if (ct.includes("word")) return "DOC";
  return (ct.split("/")[1] || "FILE").slice(0, 5).toUpperCase();
};

function EmailBody({ previewHtml, previewPlain, previewImages, previewMode, rawText }) {
  if (previewMode === "plain" && previewPlain) {
    return <div className="rd-body">{previewPlain}</div>;
  }
  if ((previewMode === "html" || previewMode === "html_images") && previewHtml) {
    const safe = sanitizeEmailHtml(previewHtml);
    return (
      <div className="rd-body email-preview-html" dangerouslySetInnerHTML={{ __html: safe }} />
    );
  }
  if (previewImages?.length) {
    return (
      <div className="rd-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {previewImages.map((img, i) => (
          <img key={i} src={img.data_url} alt="" style={{ maxWidth: "100%", borderRadius: 8 }} />
        ))}
      </div>
    );
  }
  return <div className="rd-body">{rawText || "Loading the original email…"}</div>;
}

export default function EmailDetail({
  attachment,
  emailId,
  sender = "Vessel Owner",
  subject,
  date,
  files = [],
  positions,
  onConfirm,
  onVerifiedChange,
}) {
  const [raw, setRaw] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewPlain, setPreviewPlain] = useState("");
  const [previewImages, setPreviewImages] = useState([]);
  const [previewMode, setPreviewMode] = useState("fallback");
  const [isVerified, setIsVerified] = useState(false);
  const [canVerify, setCanVerify] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState(false);
  const [viewFile, setViewFile] = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  const detailCols = [...new Set(positions.flatMap((v) => Object.keys(v.dynamic_data || {})))]
    .filter((k) => k !== "vessel_name" && k !== "name");

  const loadRaw = useCallback(async () => {
    try {
      const r = await getAttachmentRaw(attachment.id);
      setRaw(r.raw_text || "");
      setPreviewHtml(r.preview_html || "");
      setPreviewPlain(r.preview_plain || "");
      setPreviewImages(Array.isArray(r.preview_images) ? r.preview_images : []);
      setPreviewMode(resolvePreviewMode(r));
      setIsVerified(Boolean(r.is_verified));
      const count = r.vessel_count ?? positions.length;
      setCanVerify(r.status === "done" && count >= 1);
    } catch {
      setRaw("");
    }
  }, [attachment.id, positions.length]);

  useEffect(() => {
    setViewFile(null);
    loadRaw();
  }, [loadRaw]);

  const handleVerify = async () => {
    setVerifyBusy(true);
    try {
      const result = await setAttachmentVerified(attachment.id, true);
      setIsVerified(Boolean(result.is_verified));
      onVerifiedChange?.();
    } catch (e) {
      alert(e.message || "Verify failed");
    } finally {
      setVerifyBusy(false);
    }
  };

  const flagged = positions.filter(needsReview);
  const confirm = async (v) => { setBusy(true); await onConfirm(v, (edits[v.id] ?? "").trim()); setBusy(false); };
  const av = AV[(sender.charCodeAt(0) || 0) % AV.length];

  const url = viewFile ? attachmentFileUrl(attachment.id, viewFile.idx) : null;
  const isImg = viewFile?.content_type?.startsWith("image/");
  const isPdf = viewFile?.content_type?.includes("pdf");

  return (
    <div className="reading">
      <div className="rd-head">
        <div className="rd-av" style={{ background: av }}>{sender[0]?.toUpperCase() || "•"}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rd-subject">{subject || "Vessel positions"}</div>
          <div className="rd-meta"><b>{sender}</b> · {date}</div>
        </div>
        <VerifyButton
          verified={isVerified}
          canVerify={canVerify}
          busy={verifyBusy}
          onVerify={handleVerify}
        />
        <span className={`st-pill ${flagged.length ? "st-rev" : isVerified ? "st-auto" : "st-rev"}`} style={{ marginLeft: 8 }}>
          {isVerified ? "✓ verified" : flagged.length ? `⚠ ${flagged.length} to review` : "pending verify"}
        </span>
      </div>

      <div className="rd-split">
        <div className="rd-col">
          <div className="rd-colhead"><Icon name="mail" size={13} /> Original email — as received</div>
          <div className="rd-scroll">
            <EmailBody
              previewHtml={previewHtml}
              previewPlain={previewPlain}
              previewImages={previewImages}
              previewMode={previewMode}
              rawText={raw}
            />
            {files.length > 0 && (
              <div className="rd-attbox">
                <div className="rd-attbox-lbl"><Icon name="clip" size={13} /> {files.length} attachment{files.length !== 1 ? "s" : ""} — click to view</div>
                <div className="rd-attgrid">
                  {files.map((f) => (
                    <button key={f.idx} className="att-card" onClick={() => setViewFile(f)} title={f.name}>
                      <span className="att-ic">{shortType(f.content_type)}</span>
                      <span className="att-info">
                        <span className="att-name">{f.name}</span>
                        <span className="att-sub">{fmtSize(f.size)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="rd-col">
          <div className="rd-colhead">
            <Icon name="navigation" size={13} /> Extracted data
            <span className="rd-src">from email body · {positions.length}</span>
            {positions.length > 0 && (
              <button className="rd-full" type="button" onClick={() => setShowPreview(true)}>
                ⤢ Full table
              </button>
            )}
          </div>
          <div className="rd-scroll rd-positions">
            {positions.length === 0 ? (
              <div className="rd-none">No positions were extracted from this email.</div>
            ) : positions.map((v) => {
              const flag = needsReview(v); const d = v.dynamic_data || {};
              const dwt = pick(d, ["dwt", "sdwt", "dwt_cbm"]);
              const dates = pick(d, ["open_date", "dates", "date", "open_range", "eta", "when"]);
              const built = pick(d, ["built", "yard_built"]);
              const port = pick(d, ["open", "open_location", "open_port", "port", "port_name", "position"]);
              return (
                <div className={`pos-row ${flag ? "flagged" : ""}`} key={v.id}>
                  <div className="pos-name">{vesselName(v)}</div>
                  <div className="pos-meta">
                    <span className="pos-region">{regionUnknown(v.region) ? "⚠ region?" : v.region}</span>
                    {port && <span>{port}</span>}{dates && <span>{dates}</span>}
                    {dwt && <span>{dwt}</span>}{built && <span>blt {built}</span>}
                  </div>
                  {flag && (
                    <div className="pos-confirm">
                      <input placeholder="open region…" value={edits[v.id] ?? ""}
                        onChange={(e) => setEdits((p) => ({ ...p, [v.id]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && confirm(v)} />
                      <button className="cbtn" type="button" disabled={busy} onClick={() => confirm(v)}>✓ Confirm</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {showPreview && (
        <PreviewModal
          attachmentId={attachment.id}
          filename={attachment.filename}
          emailId={emailId}
          initialVerified={isVerified}
          vesselCount={positions.length}
          onVerifiedChange={() => { loadRaw(); onVerifiedChange?.(); }}
          onDataChange={onVerifiedChange}
          onClose={() => setShowPreview(false)}
        />
      )}

      {viewFile && (
        <div className="modal-bg" onClick={(e) => e.target.classList.contains("modal-bg") && setViewFile(null)}>
          <div className="fileviewer">
            <div className="fv-head">
              <span className="fv-badge">{shortType(viewFile.content_type)}</span>
              <span className="fv-name">{viewFile.name}</span>
              <span className="fv-size">{fmtSize(viewFile.size)}</span>
              <a className="fv-dl" href={url} download={viewFile.name} target="_blank" rel="noreferrer">Download ↓</a>
              <button className="fv-x" type="button" onClick={() => setViewFile(null)}>✕</button>
            </div>
            <div className="fv-body">
              {isImg ? <img src={url} alt={viewFile.name} />
                : isPdf ? <PdfView url={url} />
                : <div className="fv-none"><Icon name="file" size={38} /><p>Preview isn’t supported for this file type.</p><a className="fv-dl" href={url} download={viewFile.name}>Download {viewFile.name}</a></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
