import { useState, useEffect, useCallback, useRef } from "react";
import { getAllVessels, getColumns, updateVessel, deleteVessel, createVessel, generateDraft } from "../../services/api";
import { useSSE } from "../../hooks/useSSE";
import EditableGrid from "./EditableGrid";

export default function ValidationView({ emailId, onDraftGenerated }) {
  const [vessels, setVessels]       = useState([]);
  const [columns, setColumns]       = useState([]);
  const [loading, setLoading]       = useState(false);
  const [generating, setGenerating] = useState(false);
  const [draftJobId, setDraftJobId] = useState(null);
  const [error, setError]           = useState("");
  const [savedMsg, setSavedMsg]     = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const savedTimer                  = useRef(null);

  const vesselsRef = useRef(vessels);
  useEffect(() => { vesselsRef.current = vessels; }, [vessels]);

  useEffect(() => {
    if (!emailId) return;
    load();
  }, [emailId]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [vesselData, colData] = await Promise.all([
        getAllVessels(emailId),
        getColumns(emailId),
      ]);
      // Sort by filename so group headers are contiguous
      vesselData.sort((a, b) =>
        (a.filename || a.attachment_id || "").localeCompare(b.filename || b.attachment_id || "")
      );
      setVessels(vesselData);
      setColumns(colData.columns || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDraftEvent = useCallback((evt) => {
    if (evt.type === "drafting_done") {
      setGenerating(false);
      setDraftJobId(null);
      onDraftGenerated(evt.draft_html || "", evt.zones || []);
    } else if (evt.type === "phase2_failed") {
      setGenerating(false);
      setDraftJobId(null);
      setError("Draft generation failed: " + (evt.error || "Unknown error"));
    }
  }, [onDraftGenerated]);

  useSSE(draftJobId, handleDraftEvent);

  const flashSaved = () => {
    setSavedMsg(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedMsg(false), 2000);
  };

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
    savePromise.then(flashSaved).catch(console.error);
  }, []);

  const handleDeleteRow = useCallback(async (rowId) => {
    setVessels((prev) => prev.filter((v) => v.id !== rowId));
    deleteVessel(rowId).catch(console.error);
  }, []);

  const handleToggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allSelected = vessels.length > 0 && vessels.every((v) => prev.has(v.id));
      if (allSelected) return new Set();
      return new Set(vessels.map((v) => v.id));
    });
  }, [vessels]);

  const handleAddRow = async () => {
    if (!emailId) return;
    try {
      const newVessel = await createVessel(emailId);
      setVessels((prev) => [...prev, newVessel]);
      flashSaved();
    } catch (e) {
      setError("Failed to add row: " + e.message);
    }
  };

  const sourceCount = new Set(vessels.map((v) => v.attachment_id).filter(Boolean)).size;

  const handleGenerateDraft = async () => {
    if (!emailId) { setError("No email selected."); return; }
    setGenerating(true);
    setError("");
    const sourceVessels = selectedIds.size > 0
      ? vessels.filter((v) => selectedIds.has(v.id))
      : vessels;
    const payload = sourceVessels.map((v) => ({
      id: v.id,
      dynamic_data: v.dynamic_data,
      region: v.region,
      attachment_id: v.attachment_id,
      filename: v.filename,
      signature_emails: v.signature_emails ?? "",
      signature_phones: v.signature_phones ?? "",
    }));
    try {
      const { job_id } = await generateDraft(emailId, payload, columns);
      setDraftJobId(job_id);
    } catch (e) {
      setGenerating(false);
      setError("Failed to start draft: " + e.message);
    }
  };

  return (
    <div className="flex flex-col h-full gap-0" style={{ background: "#f0f9ff" }}>

      {/* ── Top bar — ocean gradient ── */}
      <div
        className="flex items-center justify-between px-6 py-4 flex-shrink-0 shadow-md"
        style={{ background: "linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%)" }}
      >
        <div>
          <h2 className="text-base font-bold text-white tracking-wide">⚓ Validation Grid</h2>
          <p className="text-xs mt-0.5" style={{ color: "#bae6fd" }}>
            {emailId
              ? `${vessels.length} vessels across ${sourceCount} source file${sourceCount !== 1 ? "s" : ""} — double-click any cell to edit`
              : "Select an email from the Inbox to load vessels."}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Auto-save indicator */}
          <span
            className={`text-xs font-semibold transition-all duration-300 ${savedMsg ? "opacity-100" : "opacity-0"}`}
            style={{ color: "#6ee7b7" }}
          >
            ✓ Saved
          </span>

          {emailId && (
            <button
              onClick={load}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shadow-sm disabled:opacity-50"
              style={{ background: "rgba(255,255,255,0.12)", color: "#e0f2fe", border: "1px solid rgba(186,230,253,0.4)" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.22)"}
              onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.12)"}
            >
              ↺ Reload
            </button>
          )}

          {emailId && (
            <button
              onClick={handleAddRow}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shadow-sm disabled:opacity-50"
              style={{ background: "rgba(255,255,255,0.12)", color: "#7dd3fc", border: "1px solid rgba(125,211,252,0.4)" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.22)"}
              onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.12)"}
            >
              ＋ Add Row
            </button>
          )}

          {emailId && vessels.length > 0 && (
            <button
              onClick={() => setDeleteMode((d) => !d)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shadow-sm"
              style={deleteMode
                ? { background: "#ef4444", color: "#fff", border: "1px solid #dc2626" }
                : { background: "rgba(239,68,68,0.15)", color: "#fca5a5", border: "1px solid rgba(252,165,165,0.4)" }
              }
              onMouseEnter={e => e.currentTarget.style.background = deleteMode ? "#dc2626" : "rgba(239,68,68,0.25)"}
              onMouseLeave={e => e.currentTarget.style.background = deleteMode ? "#ef4444" : "rgba(239,68,68,0.15)"}
            >
              🗑 {deleteMode ? "Exit Delete Mode" : "Delete Mode"}
            </button>
          )}

          <button
            onClick={handleGenerateDraft}
            disabled={!emailId || generating || loading || vessels.length === 0}
            className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "#fff", color: "#0c4a6e", border: "none" }}
            onMouseEnter={e => { if (!generating) e.currentTarget.style.background = "#e0f2fe"; }}
            onMouseLeave={e => { if (!generating) e.currentTarget.style.background = "#fff"; }}
          >
            {generating ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
                  style={{ borderColor: "#0369a1", borderTopColor: "transparent" }} />
                Generating draft…
              </>
            ) : selectedIds.size > 0 ? (
              `✔ Generate Draft — ${selectedIds.size} selected`
            ) : (
              `✔ Generate Draft — All ${vessels.length}`
            )}
          </button>
        </div>
      </div>

      {/* ── Stats bar ── */}
      {vessels.length > 0 && (
        <div className="flex gap-3 px-6 py-3 flex-shrink-0" style={{ background: "#e0f2fe", borderBottom: "1px solid #bae6fd" }}>
          <Stat label="Vessels" value={vessels.length} />
          <Stat label="Sources" value={sourceCount} />
          <Stat label="Regions" value={new Set(vessels.map((v) => v.region).filter(Boolean)).size} />
          <Stat label="Columns" value={columns.length} />
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="flex-shrink-0 mx-6 mt-3 px-4 py-2 rounded-lg text-sm"
          style={{ background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626" }}>
          {error}
        </div>
      )}

      {/* ── Grid ── */}
      <div className="flex-1 min-h-0 px-4 py-3 overflow-hidden flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "#7dd3fc" }}>
            <span className="inline-block w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin mr-2" />
            Loading vessels…
          </div>
        ) : (
          <EditableGrid
            data={vessels}
            columns={columns}
            onCellEdit={handleCellEdit}
            onDeleteRow={handleDeleteRow}
            deleteMode={deleteMode}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleAll={handleToggleAll}
          />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="px-3 py-1.5 rounded-lg text-xs shadow-sm"
      style={{ background: "#fff", border: "1px solid #bae6fd" }}>
      <span style={{ color: "#7dd3fc" }}>{label}: </span>
      <span className="font-bold" style={{ color: "#0369a1" }}>{value}</span>
    </div>
  );
}
