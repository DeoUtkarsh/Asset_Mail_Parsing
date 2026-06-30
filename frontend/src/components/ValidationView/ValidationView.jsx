import { useState, useEffect, useCallback, useRef } from "react";
import { getAllVesselsCombined, getColumnDefinitions, updateVessel, deleteVessel, generateDraft } from "../../services/api";
import { useSSE } from "../../hooks/useSSE";
import EditableGrid from "./EditableGrid";
import DraftModal from "./DraftModal";

export default function ValidationView({ draftEmailId, refreshKey = 0 }) {
  const [vessels, setVessels]       = useState([]);
  const [columnDefs, setColumnDefs] = useState([]);
  const [loading, setLoading]       = useState(false);
  const [generating, setGenerating] = useState(false);
  const [draftJobId, setDraftJobId] = useState(null);
  const [error, setError]           = useState("");
  const [savedMsg, setSavedMsg]     = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [draftData, setDraftData]   = useState(null);
  const [draftModalOpen, setDraftModalOpen] = useState(false);
  const savedTimer                  = useRef(null);
  const draftSourceRef              = useRef({ vessels: [], columns: [] });

  const vesselsRef = useRef(vessels);
  useEffect(() => { vesselsRef.current = vessels; }, [vessels]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [vesselData, colData] = await Promise.all([
        getAllVesselsCombined(),
        getColumnDefinitions(),
      ]);
      setVessels(vesselData);
      setColumnDefs(colData.columns || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const handleDraftEvent = useCallback((evt) => {
    if (evt.type === "drafting_done") {
      setGenerating(false);
      setDraftJobId(null);
      setDraftData({
        html: evt.draft_html || "",
        zones: evt.zones || [],
        vessels: draftSourceRef.current.vessels,
        columns: draftSourceRef.current.columns,
      });
      setDraftModalOpen(true);
    } else if (evt.type === "phase2_failed") {
      setGenerating(false);
      setDraftJobId(null);
      setError("Draft generation failed: " + (evt.error || "Unknown error"));
    }
  }, []);

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
    savePromise.then(flashSaved).catch((e) => setError("Failed to save: " + e.message));
  }, []);

  const handleDeleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    setVessels((prev) => prev.filter((v) => !selectedIds.has(v.id)));
    setSelectedIds(new Set());
    try {
      await Promise.all(ids.map((id) => deleteVessel(id)));
      flashSaved();
    } catch (e) {
      setError("Failed to delete rows: " + e.message);
      load();
    }
  }, [selectedIds, load]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (selectedIds.size === 0) return;
      if (e.key !== "Delete") return;
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      e.preventDefault();
      handleDeleteSelected();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds, handleDeleteSelected]);

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

  const sourceCount = new Set(vessels.map((v) => v.attachment_id).filter(Boolean)).size;

  const handleGenerateDraft = async () => {
    const emailId =
      draftEmailId ||
      vessels.find((v) => v.parent_email_id)?.parent_email_id;
    if (!emailId) {
      setError("No validation-ready email found for draft generation.");
      return;
    }
    setGenerating(true);
    setError("");
    setDraftData(null);
    setDraftModalOpen(false);
    const sourceVessels = selectedIds.size > 0
      ? vessels.filter((v) => selectedIds.has(v.id))
      : vessels;
    draftSourceRef.current = { vessels: sourceVessels, columns: columnDefs.map((c) => c.id) };
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
      const { job_id } = await generateDraft(emailId, payload, columnDefs.map((c) => c.id));
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
          <h2 className="text-base font-bold text-white tracking-wide">Vessel Position List</h2>
        </div>

        <div className="flex items-center gap-3">
          {/* Auto-save indicator */}
          <span
            className={`text-xs font-semibold transition-all duration-300 ${savedMsg ? "opacity-100" : "opacity-0"}`}
            style={{ color: "#6ee7b7" }}
          >
            ✓ Saved
          </span>

          <button
            onClick={handleGenerateDraft}
            disabled={generating || loading || vessels.length === 0}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium transition-all shadow-sm bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-sky-600"
          >
            {generating ? (
              <>
                <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Generating draft…
              </>
            ) : selectedIds.size > 0 ? (
              `Draft Email Position List — ${selectedIds.size} selected`
            ) : (
              `Draft Email Position List`
            )}
          </button>

          {draftData && !generating && (
            <button
              type="button"
              onClick={() => setDraftModalOpen(true)}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium transition-all shadow-sm bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <span aria-hidden>✓</span>
              View Map &amp; Draft
            </button>
          )}
        </div>
      </div>

      {/* ── Stats bar ── */}
      {vessels.length > 0 && (
        <div className="flex gap-2 px-4 py-2 flex-shrink-0" style={{ background: "#e0f2fe", borderBottom: "1px solid #bae6fd" }}>
          <Stat label="Vessels" value={vessels.length} />
          <Stat label="Sources" value={sourceCount} />
          <Stat label="Regions" value={new Set(vessels.map((v) => v.region).filter(Boolean)).size} />
          <Stat label="Columns" value={columnDefs.length} />
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
      <div className="flex-1 min-h-0 px-3 py-2 overflow-hidden flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "#7dd3fc" }}>
            <span className="inline-block w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin mr-2" />
            Loading vessels…
          </div>
        ) : (
          <EditableGrid
            data={vessels}
            gridColumns={columnDefs}
            onCellEdit={handleCellEdit}
            readOnly
            showCheckboxes
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleAll={handleToggleAll}
            emptyMessage="No verified vessels yet. Verify attachments on Email Data to add them here."
          />
        )}
      </div>

      <DraftModal
        open={draftModalOpen}
        onClose={() => setDraftModalOpen(false)}
        html={draftData?.html}
        zones={draftData?.zones}
        vessels={draftData?.vessels}
        columns={draftData?.columns}
      />
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="px-2 py-1 rounded-md text-[11px] shadow-sm"
      style={{ background: "#fff", border: "1px solid #bae6fd" }}>
      <span style={{ color: "#7dd3fc" }}>{label}: </span>
      <span className="font-bold" style={{ color: "#0369a1" }}>{value}</span>
    </div>
  );
}
