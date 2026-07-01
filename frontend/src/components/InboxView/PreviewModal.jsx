import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  getAttachmentRaw,
  getVesselsForAttachment,
  getColumnDefinitions,
  updateVessel,
  setAttachmentVerified,
} from "../../services/api";
import EditableGrid from "../ValidationView/EditableGrid";
import VerifyButton from "./VerifyButton";
import AllColumnsToggle from "../ValidationView/AllColumnsToggle";
import { sanitizeEmailHtml, resolvePreviewMode } from "../../utils/emailPreview";
import {
  filterPositionListGridColumns,
  readPreviewShowAllColumnsPref,
  writePreviewShowAllColumnsPref,
} from "../../utils/standardColumns";

function looksLikeHtml(s) {
  if (!s || s.length < 12) return false;
  const head = s.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<meta");
}

/** Fallback when no stored preview fields (older attachments). */
function toFallbackPlainText(s) {
  if (!s) return "";
  if (!looksLikeHtml(s)) return s;
  try {
    const doc = new DOMParser().parseFromString(s, "text/html");
    const t = doc.body?.innerText;
    if (t && t.replace(/\s/g, "").length > 0) return t.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    /* fall through */
  }
  return s
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function OriginalMessagePanel({
  previewMode,
  previewHtml,
  previewPlain,
  previewImages,
  rawText,
  view,
}) {
  if (view === "plain" && previewPlain) {
    return (
      <pre
        className="flex-1 min-h-0 overflow-y-auto p-4 text-[12px] font-mono whitespace-pre-wrap leading-relaxed"
        style={{ background: "#fff", color: "#0c4a6e" }}
      >
        {previewPlain}
      </pre>
    );
  }

  if (view === "fallback") {
    const text = toFallbackPlainText(rawText);
    return (
      <pre
        className="flex-1 min-h-0 overflow-y-auto p-4 text-[12px] font-mono whitespace-pre-wrap leading-relaxed"
        style={{ background: "#fff", color: "#0c4a6e" }}
      >
        {text || (
          <span style={{ color: "#94a3b8", fontStyle: "italic" }}>
            No message content available. Re-fetch this email to load a formatted preview.
          </span>
        )}
      </pre>
    );
  }

  const showHtml = (previewMode === "html" || previewMode === "html_images") && previewHtml;
  const showImages =
    previewMode === "images" ||
    previewMode === "html_images" ||
    (previewImages?.length > 0 && !showHtml);

  if (!showHtml && !showImages) {
    if (previewPlain) {
      return (
        <pre
          className="flex-1 min-h-0 overflow-y-auto p-4 text-[12px] font-mono whitespace-pre-wrap leading-relaxed"
          style={{ background: "#fff", color: "#0c4a6e" }}
        >
          {previewPlain}
        </pre>
      );
    }
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4 text-sm" style={{ color: "#64748b" }}>
        No original message to display.
      </div>
    );
  }

  const safeHtml = showHtml ? sanitizeEmailHtml(previewHtml) : "";

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto p-4 email-preview-body"
      style={{ background: "#fff", color: "#0f172a" }}
    >
      {showHtml && (
        <div
          className="email-preview-html text-sm leading-relaxed"
          dangerouslySetInnerHTML={{ __html: safeHtml }}
        />
      )}
      {showImages && previewImages?.length > 0 && (
        <div className={showHtml ? "mt-4 space-y-3" : "space-y-3"}>
          {previewImages.map((img, idx) => (
            <img
              key={idx}
              src={img.data_url}
              alt={`Inline attachment ${idx + 1}`}
              className="max-w-full h-auto rounded border border-slate-200 shadow-sm"
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function PreviewModal({
  attachmentId,
  filename,
  emailId,
  initialVerified = false,
  vesselCount = 0,
  onVerifiedChange,
  onClose,
}) {
  const [rawText, setRawText] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewPlain, setPreviewPlain] = useState("");
  const [previewImages, setPreviewImages] = useState([]);
  const [previewMode, setPreviewMode] = useState("fallback");
  const [vessels, setVessels] = useState([]);
  const [columnDefs, setColumnDefs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [messageView, setMessageView] = useState("original");
  const [savedMsg, setSavedMsg] = useState(false);
  const [error, setError] = useState("");
  const [isVerified, setIsVerified] = useState(initialVerified);
  const [canVerify, setCanVerify] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [showAllColumns, setShowAllColumns] = useState(() => readPreviewShowAllColumnsPref());
  const savedTimer = useRef(null);
  const vesselsRef = useRef(vessels);

  useEffect(() => { vesselsRef.current = vessels; }, [vessels]);

  const hasPlainToggle = useMemo(
    () => Boolean(previewPlain) && previewMode !== "plain" && previewMode !== "fallback",
    [previewPlain, previewMode],
  );

  const previewGridColumns = useMemo(
    () => filterPositionListGridColumns(columnDefs, showAllColumns),
    [columnDefs, showAllColumns],
  );

  const toggleShowAllColumns = useCallback((next) => {
    setShowAllColumns((prev) => {
      const value = typeof next === "boolean" ? next : !prev;
      writePreviewShowAllColumnsPref(value);
      return value;
    });
  }, []);

  const flashSaved = () => {
    setSavedMsg(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedMsg(false), 2000);
  };

  useEffect(() => {
    setMessageView("original");
    setError("");
    setIsVerified(initialVerified);
  }, [attachmentId, initialVerified]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [rawData, vesselData, colData] = await Promise.all([
          getAttachmentRaw(attachmentId),
          getVesselsForAttachment(attachmentId),
          getColumnDefinitions(),
        ]);
        if (cancelled) return;
        setRawText(rawData.raw_text || "");
        setPreviewHtml(rawData.preview_html || "");
        setPreviewPlain(rawData.preview_plain || "");
        setPreviewImages(Array.isArray(rawData.preview_images) ? rawData.preview_images : []);
        setPreviewMode(resolvePreviewMode(rawData));
        setColumnDefs(colData.columns || []);
        setIsVerified(Boolean(rawData.is_verified ?? initialVerified));
        const count = rawData.vessel_count ?? vesselData.length;
        setCanVerify(rawData.status === "done" && count >= 1);
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
  }, [attachmentId, emailId, filename, initialVerified]);

  useEffect(() => {
    setIsVerified(initialVerified);
  }, [initialVerified]);

  const handleSetVerified = useCallback(async (verified) => {
    setVerifyBusy(true);
    try {
      const result = await setAttachmentVerified(attachmentId, verified);
      setIsVerified(Boolean(result.is_verified));
      onVerifiedChange?.();
    } catch (e) {
      setError(e.message || "Verify failed.");
    } finally {
      setVerifyBusy(false);
    }
  }, [attachmentId, onVerifiedChange]);

  const handleCellEdit = useCallback(async (rowId, field, value) => {
    if (isVerified) return;
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
  }, [isVerified]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const messageViewLabel =
    messageView === "plain"
      ? "Plain text"
      : previewMode === "fallback"
        ? "Message text"
        : "Original message";

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
          <div className="flex items-center gap-3 flex-shrink-0">
            {!loading && vessels.length > 0 && columnDefs.length > 0 && (
              <AllColumnsToggle
                enabled={showAllColumns}
                onChange={toggleShowAllColumns}
                visibleCount={previewGridColumns.length}
                totalCount={columnDefs.length}
              />
            )}
            <VerifyButton
              verified={isVerified}
              canVerify={canVerify}
              busy={verifyBusy}
              onToggle={() => handleSetVerified(!isVerified)}
            />
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

              <div className="flex-1 min-h-0 px-1 pb-1 flex flex-col" style={{ background: "#f0f9ff" }}>
                <EditableGrid
                  data={vessels}
                  gridColumns={previewGridColumns}
                  onCellEdit={handleCellEdit}
                  readOnly={isVerified}
                  showCheckboxes={false}
                  hideGroupHeaders
                  stretchToFill={!showAllColumns}
                  isActive
                  emptyMessage="No vessels extracted for this attachment. Use Retry Failed on Email Data to re-extract."
                />
              </div>
            </div>

            {/* ── Bottom: original message ── */}
            <div className="flex flex-col min-h-0 flex-1">
              <div
                className="px-3 py-1 flex-shrink-0 flex items-center justify-between gap-2"
                style={{ background: "#e0f2fe", borderBottom: "1px solid #bae6fd" }}
              >
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "#0369a1" }}>
                  {messageViewLabel}
                </span>
                <div className="flex items-center gap-2">
                  {hasPlainToggle && (
                    <button
                      type="button"
                      onClick={() => setMessageView((v) => (v === "original" ? "plain" : "original"))}
                      className="text-[11px] font-semibold px-2 py-1 rounded-md shrink-0"
                      style={{
                        background: "#fff",
                        color: "#0369a1",
                        border: "1px solid #bae6fd",
                      }}
                    >
                      {messageView === "original" ? "Show plain text" : "Show original"}
                    </button>
                  )}
                  {previewMode === "fallback" && rawText && (
                    <span className="text-[10px]" style={{ color: "#64748b" }}>
                      Re-fetch for formatted preview
                    </span>
                  )}
                </div>
              </div>
              <OriginalMessagePanel
                previewMode={previewMode}
                previewHtml={previewHtml}
                previewPlain={previewPlain}
                previewImages={previewImages}
                rawText={rawText}
                view={messageView === "plain" ? "plain" : previewMode === "fallback" ? "fallback" : "original"}
              />
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
          {isVerified ? (
            <>
              {" · "}
              Click ✓ Verified to un-verify and edit again
            </>
          ) : (
            <>
              {" · "}
              Double-click a cell to edit
            </>
          )}
        </div>
      </div>
    </div>
  );
}
