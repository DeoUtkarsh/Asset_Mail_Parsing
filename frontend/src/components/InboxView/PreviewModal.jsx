import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  getAttachmentRaw,
  getVesselsForAttachment,
  updateVessel,
} from "../../services/api";
import EditableGrid from "../ValidationView/EditableGrid";
import { STANDARD_COLUMN_IDS } from "../../utils/standardColumns";

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

export default function PreviewModal({ attachmentId, filename, emailId, onClose }) {
  const [rawText, setRawText] = useState("");
  const [vessels, setVessels] = useState([]);
  const [columns] = useState(STANDARD_COLUMN_IDS);
  const [loading, setLoading] = useState(true);
  const [showRawSource, setShowRawSource] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const [error, setError] = useState("");
  const savedTimer = useRef(null);
  const vesselsRef = useRef(vessels);

  useEffect(() => { vesselsRef.current = vessels; }, [vessels]);

  const plainPreview = useMemo(() => toPreviewPlainText(rawText), [rawText]);
  const hasHtmlLike = useMemo(() => looksLikeHtml(rawText), [rawText]);

  const flashSaved = () => {
    setSavedMsg(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedMsg(false), 2000);
  };

  useEffect(() => {
    setShowRawSource(false);
    setError("");
  }, [attachmentId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [rawData, vesselData] = await Promise.all([
          getAttachmentRaw(attachmentId),
          getVesselsForAttachment(attachmentId),
        ]);
        if (cancelled) return;
        setRawText(rawData.raw_text || "");
        const enriched = vesselData.map((v) => ({
          ...v,
          attachment_id: attachmentId,
          filename: rawData.filename || filename,
          signature_emails: rawData.signature_emails || "",
          signature_phones: rawData.signature_phones || "",
        }));
        setVessels(enriched);
      } catch (e) {
        if (!cancelled) {
          console.error(e);
          setError(e.message || "Failed to load preview.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [attachmentId, emailId, filename]);

  const handleCellEdit = useCallback(async (rowId, field, value) => {
    if (field === "signature_emails" || field === "signature_phones") return;
    setVessels((prev) =>
      prev.map((v) => {
        if (v.id !== rowId) return v;
        if (field === "__region__") return { ...v, region: value };
        return { ...v, dynamic_data: { ...v.dynamic_data, [field]: value } };
      })
    );
    const vessel = vesselsRef.current.find((v) => v.id === rowId);
    if (!vessel) return;
    const savePromise = field === "__region__"
      ? updateVessel(rowId, vessel.dynamic_data, value)
      : updateVessel(rowId, { ...vessel.dynamic_data, [field]: value }, vessel.region);
    savePromise.then(flashSaved).catch((e) => setError("Failed to save: " + e.message));
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(12, 74, 110, 0.55)" }}>
      <div
        className="relative w-[95vw] h-[90vh] rounded-2xl shadow-2xl flex flex-col min-h-0"
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
          <div className="flex-1 flex flex-col min-h-0">

            {/* ── Top half: editable vessel grid ── */}
            <div
              className="flex flex-col min-h-0 shrink-0"
              style={{ height: "42%", borderBottom: "1px solid #bae6fd" }}
            >
              <div
                className="px-3 py-1 flex-shrink-0 flex items-center justify-between gap-2"
                style={{ background: "#e0f2fe", borderBottom: "1px solid #bae6fd" }}
              >
                <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#0369a1" }}>
                  Extracted Vessels
                </span>
                <span
                  className={`text-xs font-semibold transition-all duration-300 ${savedMsg ? "opacity-100" : "opacity-0"}`}
                  style={{ color: "#0891b2" }}
                >
                  ✓ Saved
                </span>
              </div>

              {error && (
                <div className="flex-shrink-0 mx-2 mt-1 px-3 py-1.5 rounded-lg text-xs"
                  style={{ background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626" }}>
                  {error}
                </div>
              )}

              <div className="flex-1 min-h-0 px-1 pb-1 flex flex-col">
                <EditableGrid
                  data={vessels}
                  columns={columns}
                  onCellEdit={handleCellEdit}
                  showCheckboxes={false}
                  hideGroupHeaders
                />
              </div>
            </div>

            {/* ── Bottom: message text ── */}
            <div className="flex flex-col min-h-0 flex-1">
              <div
                className="px-3 py-1 flex-shrink-0 flex items-center justify-between gap-2"
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
                className="flex-1 min-h-0 overflow-y-auto p-3 text-[11px] font-mono whitespace-pre-wrap leading-snug"
                style={{ background: "#fff", color: "#0c4a6e" }}
              >
                {(showRawSource ? rawText : plainPreview) || (
                  <span style={{ color: "#bae6fd", fontStyle: "italic" }}>No text extracted.</span>
                )}
              </pre>
            </div>

          </div>
        )}

        {/* ── Footer ── */}
        <div
          className="px-4 py-1 text-[10px] flex-shrink-0"
          style={{ background: "#e0f2fe", borderTop: "1px solid #bae6fd", color: "#7dd3fc" }}
        >
          Press <kbd className="px-1.5 py-0.5 rounded text-xs font-mono"
            style={{ background: "#fff", border: "1px solid #bae6fd", color: "#0369a1" }}>Esc</kbd> to close
          {" · "}
          Double-click a cell to edit
        </div>
      </div>
    </div>
  );
}
