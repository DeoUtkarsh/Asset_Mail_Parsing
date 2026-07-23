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
  sortVesselsBySourceOrder,
} from "../../utils/standardColumns";
import {
  formatStandardField,
  formatDwtSdwt,
  parseAiNormalized,
  formatAiNormalized,
} from "../../utils/fieldFormat";
import CellHighlightLegend from "../CellHighlightLegend";

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
    return <pre className="ipreview-msg-pre">{previewPlain}</pre>;
  }

  if (view === "fallback") {
    const text = toFallbackPlainText(rawText);
    return (
      <pre className="ipreview-msg-pre">
        {text || (
          <span className="ipreview-msg-empty">
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
      return <pre className="ipreview-msg-pre">{previewPlain}</pre>;
    }
    return <div className="ipreview-msg-none">No original message to display.</div>;
  }

  const safeHtml = showHtml ? sanitizeEmailHtml(previewHtml) : "";

  return (
    <div className="ipreview-msg-body">
      {showHtml && (
        <div
          className="email-preview-html"
          dangerouslySetInnerHTML={{ __html: safeHtml }}
        />
      )}
      {showImages && previewImages?.length > 0 && (
        <div className={showHtml ? "ipreview-msg-imgs mt" : "ipreview-msg-imgs"}>
          {previewImages.map((img, idx) => (
            <img key={idx} src={img.data_url} alt={`Inline attachment ${idx + 1}`} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function PreviewPanel({
  attachmentId,
  filename,
  emailId,
  initialVerified = false,
  onVerifiedChange,
  onDataChange,
  onClose,
  showVerify = false,
  showEdit = false,
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
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirtyIds, setDirtyIds] = useState(() => new Set());
  const savedTimer = useRef(null);
  const vesselsRef = useRef(vessels);
  const dirtyRef = useRef(new Set());
  const editSnapshot = useRef(null);

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
    setEditMode(false);
    setDirtyIds(new Set());
    editSnapshot.current = null;
    // Only reset when switching attachments — NOT when verified status flips,
    // otherwise clicking Verify would reset edit/message state and reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId]);

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
        const enriched = sortVesselsBySourceOrder(vesselData).map((v) => ({
          ...v,
          attachment_id: attachmentId,
          filename: rawData.filename || filename,
          attachment_files: Array.isArray(rawData.files) ? rawData.files : [],
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
    // Reload only when the attachment itself changes — verifying must not
    // re-trigger the full fetch (that caused the whole pane to flicker).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId, emailId, filename]);

  useEffect(() => {
    setIsVerified(initialVerified);
  }, [initialVerified]);

  const handleSetVerified = useCallback(async (verified) => {
    setVerifyBusy(true);
    try {
      const result = await setAttachmentVerified(attachmentId, verified);
      setIsVerified(Boolean(result.is_verified));
      if (result.is_verified) {
        setEditMode(false);
        setDirtyIds(new Set());
      }
      onVerifiedChange?.(Boolean(result.is_verified));
    } catch (e) {
      setError(e.message || "Verify failed.");
    } finally {
      setVerifyBusy(false);
    }
  }, [attachmentId, onVerifiedChange]);

  const handleCellEdit = useCallback((rowId, field, value) => {
    if ((isVerified && showVerify) || !editMode) return;
    if (field === "signature_emails" || field === "signature_phones") return;
    // Update the authoritative ref synchronously so a save fired on the same
    // Enter keystroke sees the latest values (state updates are async).
    const next = vesselsRef.current.map((v) => {
      if (v.id !== rowId) return v;
      if (field === "__region__") return { ...v, region: value };
      const dd = { ...v.dynamic_data };
      if (field === "dwt_sdwt" || field === "dwt" || field === "sdwt") {
        const { value: stored, scaled } = formatDwtSdwt(value);
        dd.dwt_sdwt = stored || value;
        const flags = parseAiNormalized(dd.ai_normalized);
        if (scaled) flags.add("dwt_sdwt");
        dd.ai_normalized = formatAiNormalized(flags);
      } else {
        const stored = formatStandardField(field, value);
        dd[field] = stored || value;
      }
      return { ...v, dynamic_data: dd };
    });
    vesselsRef.current = next;
    setVessels(next);
    const nextDirty = new Set(dirtyRef.current);
    nextDirty.add(rowId);
    dirtyRef.current = nextDirty;
    setDirtyIds(nextDirty);
  }, [isVerified, editMode, showVerify]);

  const enterEditMode = useCallback(() => {
    editSnapshot.current = vesselsRef.current;
    dirtyRef.current = new Set();
    setDirtyIds(new Set());
    setError("");
    setEditMode(true);
  }, []);

  const cancelEditMode = useCallback(() => {
    if (editSnapshot.current) {
      vesselsRef.current = editSnapshot.current;
      setVessels(editSnapshot.current);
    }
    dirtyRef.current = new Set();
    setDirtyIds(new Set());
    setEditMode(false);
  }, []);

  const handleSaveChanges = useCallback(async () => {
    const ids = [...dirtyRef.current];
    if (ids.length === 0) {
      setEditMode(false);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await Promise.all(
        ids.map((id) => {
          const v = vesselsRef.current.find((x) => x.id === id);
          if (!v) return null;
          return updateVessel(id, v.dynamic_data, v.region);
        })
      );
      dirtyRef.current = new Set();
      setDirtyIds(new Set());
      setEditMode(false);
      editSnapshot.current = null;
      flashSaved();
      onDataChange?.();
    } catch (e) {
      setError("Failed to save: " + e.message);
    } finally {
      setSaving(false);
    }
  }, [onDataChange]);

  const messageViewLabel =
    messageView === "plain"
      ? "Plain text"
      : previewMode === "fallback"
        ? "Message text"
        : "Original message";

  if (loading) {
    return (
      <div className="ipreview-loading">
        <span className="spin-ring" /> Loading…
      </div>
    );
  }

  return (
    <div className="ipreview">
      {/* ── Header ── */}
      <div className="ipreview-head">
        <div className="ipreview-editbar">
          {showEdit && !isVerified && (
            editMode ? (
              <>
                <button
                  type="button"
                  className="btn-save-changes"
                  onClick={handleSaveChanges}
                  disabled={saving}
                >
                  {saving ? <><span className="spin-ring" /> Saving…</> : "Save changes"}
                </button>
                <button
                  type="button"
                  className="btn-cancel-edit"
                  onClick={cancelEditMode}
                  disabled={saving}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-edit"
                onClick={enterEditMode}
                disabled={vessels.length === 0}
                title="Edit extracted vessel fields"
              >
                ✎ Edit
              </button>
            )
          )}
          <span className={`ipreview-saved ${savedMsg ? "show" : ""}`}>✓ Saved</span>
        </div>
        <div className="ipreview-head-right">
          <CellHighlightLegend className="ipreview-legends" />
          {vessels.length > 0 && columnDefs.length > 0 && (
            <AllColumnsToggle
              enabled={showAllColumns}
              onChange={toggleShowAllColumns}
              visibleCount={previewGridColumns.length}
              totalCount={columnDefs.length}
            />
          )}
          {showVerify && (
            <VerifyButton
              verified={isVerified}
              canVerify={canVerify}
              busy={verifyBusy}
              onToggle={() => handleSetVerified(!isVerified)}
            />
          )}
          {onClose && (
            <button type="button" className="ipreview-close" onClick={onClose} title="Close">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* ── Extracted vessels grid ── */}
      <div className="ipreview-grid-sec">
        <div className="ipreview-sec-h">
          <span>Extracted Vessels</span>
          {editMode && <span className="ipreview-edit-hint">Click a cell to edit, then Save changes</span>}
        </div>
        {error && <div className="ipreview-err">{error}</div>}
        <div className="ipreview-grid-wrap">
          <EditableGrid
            data={vessels}
            gridColumns={previewGridColumns}
            onCellEdit={handleCellEdit}
            onEnterSave={handleSaveChanges}
            readOnly={!editMode || (showVerify && isVerified)}
            showCheckboxes={false}
            hideGroupHeaders
            stretchToFill={!showAllColumns}
            highlightEmpty={editMode}
          />
        </div>
      </div>

      {/* ── Original email body ── */}
      <div className="ipreview-msg-sec">
        <div className="ipreview-sec-h">
          <span>{messageViewLabel}</span>
          <div className="ipreview-sec-h-actions">
            {hasPlainToggle && (
              <button
                type="button"
                className="ipreview-toggle-btn"
                onClick={() => setMessageView((v) => (v === "original" ? "plain" : "original"))}
              >
                {messageView === "original" ? "Show plain text" : "Show original"}
              </button>
            )}
            {previewMode === "fallback" && rawText && (
              <span className="ipreview-refetch">Re-fetch for formatted preview</span>
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
  );
}
