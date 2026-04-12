import { useEffect, useMemo, useState } from "react";
import { getAttachmentRaw, getVesselsForAttachment } from "../../services/api";

function looksLikeHtml(s) {
  if (!s || s.length < 12) return false;
  const head = s.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<meta");
}

/** Prefer readable text when stored content is HTML (e.g. Word-exported bodies). */
function toPreviewPlainText(s) {
  if (!s) return "";
  if (!looksLikeHtml(s)) return s;
  try {
    const doc = new DOMParser().parseFromString(s, "text/html");
    const t = doc.body?.innerText;
    if (t && t.replace(/\s/g, "").length > 0) return t.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    /* fall through */
  }
  return s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function PreviewModal({ attachmentId, filename, onClose }) {
  const [rawText, setRawText] = useState("");
  const [signatureEmails, setSignatureEmails] = useState("");
  const [signaturePhones, setSignaturePhones] = useState("");
  const [vessels, setVessels] = useState([]);
  const [columns, setColumns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showRawSource, setShowRawSource] = useState(false);

  const plainPreview = useMemo(() => toPreviewPlainText(rawText), [rawText]);
  const hasHtmlLike = useMemo(() => looksLikeHtml(rawText), [rawText]);

  useEffect(() => {
    setShowRawSource(false);
  }, [attachmentId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [rawData, vesselData] = await Promise.all([
          getAttachmentRaw(attachmentId),
          getVesselsForAttachment(attachmentId),
        ]);
        if (cancelled) return;
        setRawText(rawData.raw_text || "");
        setSignatureEmails(rawData.signature_emails || "");
        setSignaturePhones(rawData.signature_phones || "");
        setVessels(vesselData);
        const keySet = new Set();
        vesselData.forEach((v) => Object.keys(v.dynamic_data || {}).forEach((k) => keySet.add(k)));
        setColumns(Array.from(keySet));
      } catch (e) {
        if (!cancelled) console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [attachmentId]);

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ background: "rgba(12, 74, 110, 0.55)" }}>
      <div
        className="relative w-[95vw] h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ background: "#f0f9ff", border: "1px solid #bae6fd" }}
      >
        {/* ── Header ── */}
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0"
          style={{
            background: "linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%)",
            borderBottom: "2px solid #0284c7",
          }}
        >
          <div className="flex items-center gap-3">
            <span className="text-lg">📎</span>
            <span className="font-mono text-sm font-semibold text-white truncate max-w-[55vw]">
              {filename}
            </span>
            {!loading && (
              <span
                className="text-xs font-medium px-2 py-0.5 rounded-full"
                style={{ background: "#0ea5e9", color: "#fff" }}
              >
                {vessels.length} vessel{vessels.length !== 1 ? "s" : ""} extracted
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-lg leading-none font-bold transition-colors"
            style={{ color: "#7dd3fc", background: "transparent" }}
            onMouseEnter={e => { e.currentTarget.style.background = "#0284c7"; e.currentTarget.style.color = "#fff"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#7dd3fc"; }}
          >
            ✕
          </button>
        </div>

        {/* ── Body ── */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "#7dd3fc" }}>
            <span className="inline-block w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin mr-2" />
            Loading…
          </div>
        ) : (
          <div className="flex-1 flex overflow-hidden">

            {/* ── Left: raw text ── */}
            <div className="w-1/2 flex flex-col" style={{ borderRight: "1px solid #bae6fd" }}>
              <div
                className="px-4 py-2 flex-shrink-0 flex items-center justify-between gap-2"
                style={{ background: "#e0f2fe", borderBottom: "1px solid #bae6fd" }}
              >
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "#0369a1" }}>
                  {showRawSource ? "Raw source" : "Message text (readable)"}
                </span>
                {hasHtmlLike && rawText && (
                  <button
                    type="button"
                    onClick={() => setShowRawSource((v) => !v)}
                    className="text-[11px] font-semibold px-2 py-1 rounded-md shrink-0"
                    style={{
                      background: "#fff",
                      color: "#0369a1",
                      border: "1px solid #bae6fd",
                    }}
                  >
                    {showRawSource ? "Show readable text" : "Show HTML source"}
                  </button>
                )}
              </div>
              <pre
                className="flex-1 overflow-y-auto p-4 text-xs font-mono whitespace-pre-wrap leading-relaxed"
                style={{ background: "#fff", color: "#0c4a6e" }}
              >
                {(showRawSource ? rawText : plainPreview) || (
                  <span style={{ color: "#bae6fd", fontStyle: "italic" }}>No text extracted.</span>
                )}
              </pre>
            </div>

            {/* ── Right: signature for this attachment + extracted vessels ── */}
            <div className="w-1/2 flex flex-col overflow-hidden min-h-0">
              <div
                className="px-4 py-2 flex-shrink-0"
                style={{ background: "#e0f2fe", borderBottom: "1px solid #bae6fd" }}
              >
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "#0369a1" }}>
                  Broker signature (this attachment)
                </span>
              </div>
              <div
                className="flex-shrink-0 px-4 py-3 text-xs space-y-2 border-b"
                style={{ background: "#fff", borderColor: "#e0f2fe" }}
              >
                <div>
                  <span className="font-bold uppercase tracking-wide" style={{ color: "#0369a1" }}>Emails</span>
                  <pre
                    className="mt-1 whitespace-pre-wrap font-sans leading-relaxed"
                    style={{ color: "#0c4a6e" }}
                  >
                    {signatureEmails?.trim() || "— (after Phase 1 signature pass, or empty for this file)"}
                  </pre>
                </div>
                <div>
                  <span className="font-bold uppercase tracking-wide" style={{ color: "#0369a1" }}>Phones</span>
                  <pre
                    className="mt-1 whitespace-pre-wrap font-sans leading-relaxed"
                    style={{ color: "#0c4a6e" }}
                  >
                    {signaturePhones?.trim() || "—"}
                  </pre>
                </div>
              </div>

              <div
                className="px-4 py-2 flex-shrink-0"
                style={{ background: "#e0f2fe", borderBottom: "1px solid #bae6fd" }}
              >
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "#0369a1" }}>
                  Extracted Vessels
                </span>
              </div>

              {vessels.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-sm italic" style={{ color: "#7dd3fc" }}>
                  No vessels extracted from this file.
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto" style={{ background: "#fff" }}>
                  <table className="min-w-max text-xs border-collapse">
                    <thead className="sticky top-0 z-10">
                      <tr style={{ background: "#0369a1" }}>
                        <th className="px-3 py-2 text-left font-semibold whitespace-nowrap"
                            style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}>#</th>
                        <th className="px-3 py-2 text-left font-semibold whitespace-nowrap"
                            style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}>Region</th>
                        {columns.map((col) => (
                          <th key={col}
                              className="px-3 py-2 text-left font-semibold whitespace-nowrap uppercase"
                              style={{ color: "#e0f2fe", borderBottom: "2px solid #0284c7" }}>
                            {col.replace(/_/g, " ")}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {vessels.map((v, i) => (
                        <tr
                          key={v.id}
                          style={{ background: i % 2 === 0 ? "#ffffff" : "#f0f9ff", borderBottom: "1px solid #e0f2fe" }}
                          onMouseEnter={e => e.currentTarget.style.background = "#e0f2fe"}
                          onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? "#ffffff" : "#f0f9ff"}
                        >
                          <td className="px-3 py-1.5 whitespace-nowrap" style={{ color: "#7dd3fc" }}>{i + 1}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap font-semibold" style={{ color: "#0369a1" }}>
                            {v.region || "—"}
                          </td>
                          {columns.map((col) => (
                            <td key={col} className="px-3 py-1.5 whitespace-nowrap" style={{ color: "#0c4a6e" }}>
                              {v.dynamic_data?.[col] || <span style={{ color: "#bae6fd" }}>—</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>
        )}

        {/* ── Footer ── */}
        <div
          className="px-5 py-2 text-xs flex-shrink-0"
          style={{ background: "#e0f2fe", borderTop: "1px solid #bae6fd", color: "#7dd3fc" }}
        >
          Press <kbd className="px-1.5 py-0.5 rounded text-xs font-mono"
            style={{ background: "#fff", border: "1px solid #bae6fd", color: "#0369a1" }}>Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
