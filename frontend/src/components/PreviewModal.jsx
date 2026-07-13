import { useEffect, useState } from "react";
import { getAttachmentRaw, getVesselsForAttachment } from "../services/api";
import { vesselName, regionUnknown } from "../lib/positions";

export default function PreviewModal({ attachmentId, filename, onClose }) {
  const [raw, setRaw] = useState("");
  const [vessels, setVessels] = useState([]);
  const [cols, setCols] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [r, v] = await Promise.all([getAttachmentRaw(attachmentId), getVesselsForAttachment(attachmentId)]);
        if (cancelled) return;
        setRaw(r.raw_text || "");
        setVessels(v);
        const keys = new Set();
        v.forEach((x) => Object.keys(x.dynamic_data || {}).forEach((k) => keys.add(k)));
        setCols([...keys]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [attachmentId]);

  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="pv-bg" onClick={(e) => e.target.classList.contains("pv-bg") && onClose()}>
      <div className="pv">
        <div className="pv-head">
          <span>📎</span>
          <span className="fn">{filename}</span>
          {!loading && (
            <span className="st-pill" style={{ background: "#0ea5e9", color: "#fff" }}>
              {vessels.length} position{vessels.length !== 1 ? "s" : ""}
            </span>
          )}
          <button className="cx" onClick={onClose}>✕</button>
        </div>
        <div className="pv-body">
          <div className="pv-col">
            <h4>Raw email text</h4>
            <div className="pv-raw">{raw || (loading ? "Loading…" : "No text extracted.")}</div>
          </div>
          <div className="pv-col">
            <h4>Extracted positions</h4>
            <div className="pv-vessels">
              {vessels.length === 0 ? (
                <div style={{ padding: 20, color: "var(--muted)", fontStyle: "italic" }}>
                  {loading ? "Loading…" : "No positions extracted."}
                </div>
              ) : (
                <table>
                  <thead><tr><th>#</th><th>Region</th>{cols.map((c) => <th key={c}>{c.replace(/_/g, " ")}</th>)}</tr></thead>
                  <tbody>
                    {vessels.map((v, i) => (
                      <tr key={v.id}>
                        <td style={{ color: "var(--muted)" }}>{i + 1}</td>
                        <td style={{ fontWeight: 700, color: regionUnknown(v.region) ? "var(--lo)" : "var(--brand-d)" }}>
                          {v.region || "—"}
                        </td>
                        {cols.map((c) => <td key={c}>{v.dynamic_data?.[c] || "—"}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
