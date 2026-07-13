import { useState, useEffect } from "react";
import { getAttachmentRaw, attachmentFileUrl } from "../../services/api";
import { vesselName, needsReview, regionUnknown } from "../../lib/positions";
import Icon from "../icons";
import PdfView from "../PdfView";

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

export default function EmailDetail({ attachment, sender = "Vessel Owner", subject, date, files = [], positions, onConfirm }) {
  const [raw, setRaw] = useState("");
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState(false);
  const [viewFile, setViewFile] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setRaw(""); setViewFile(null);
    getAttachmentRaw(attachment.id).then((r) => { if (!cancelled) setRaw(r.raw_text || ""); }).catch(() => {});
    return () => { cancelled = true; };
  }, [attachment.id]);

  const flagged = positions.filter(needsReview);
  const confirm = async (v) => { setBusy(true); await onConfirm(v, (edits[v.id] ?? "").trim()); setBusy(false); };
  const av = AV[(sender.charCodeAt(0) || 0) % AV.length];

  const url = viewFile ? attachmentFileUrl(attachment.id, viewFile.idx) : null;
  const isImg = viewFile?.content_type?.startsWith("image/");
  const isPdf = viewFile?.content_type?.includes("pdf");

  return (
    <div className="reading">
      {/* ── Compact email header ── */}
      <div className="rd-head">
        <div className="rd-av" style={{ background: av }}>{sender[0]?.toUpperCase() || "•"}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rd-subject">{subject || "Vessel positions"}</div>
          <div className="rd-meta"><b>{sender}</b> · {date}</div>
        </div>
        <span className={`st-pill ${flagged.length ? "st-rev" : "st-auto"}`}>
          {flagged.length ? `⚠ ${flagged.length} to review` : "✓ all confirmed"}
        </span>
      </div>

      {/* ── Compare: original email (with attachments) ⟷ extracted data ── */}
      <div className="rd-split">
        {/* LEFT — the email exactly as it was received */}
        <div className="rd-col">
          <div className="rd-colhead"><Icon name="mail" size={13} /> Original email — as received</div>
          <div className="rd-scroll">
            <div className="rd-body">{raw || "Loading the original email…"}</div>
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

        {/* RIGHT — what was parsed, and from where */}
        <div className="rd-col">
          <div className="rd-colhead">
            <Icon name="navigation" size={13} /> Extracted data
            <span className="rd-src">from email body · {positions.length}</span>
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
                      <button className="cbtn" disabled={busy} onClick={() => confirm(v)}>✓ Confirm</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Attachment viewer ── */}
      {viewFile && (
        <div className="modal-bg" onClick={(e) => e.target.classList.contains("modal-bg") && setViewFile(null)}>
          <div className="fileviewer">
            <div className="fv-head">
              <span className="fv-badge">{shortType(viewFile.content_type)}</span>
              <span className="fv-name">{viewFile.name}</span>
              <span className="fv-size">{fmtSize(viewFile.size)}</span>
              <a className="fv-dl" href={url} download={viewFile.name} target="_blank" rel="noreferrer">Download ↓</a>
              <button className="fv-x" onClick={() => setViewFile(null)}>✕</button>
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
