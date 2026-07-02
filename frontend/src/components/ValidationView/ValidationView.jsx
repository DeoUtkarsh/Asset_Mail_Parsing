import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getAllVesselsCombined, getColumnDefinitions, updateVessel, deleteVessel, generateDraft } from "../../services/api";
import { useSSE } from "../../hooks/useSSE";
import EditableGrid from "./EditableGrid";
import DraftModal from "./DraftModal";
import AllColumnsToggle from "./AllColumnsToggle";
import AiSummaryButton from "../AiSummary/AiSummaryButton";
import { summarizeVessels } from "../../services/api";
import {
  filterPositionListGridColumns,
  readPositionListShowAllColumnsPref,
  writePositionListShowAllColumnsPref,
  defaultDraftSelectedColumnIds,
  buildDraftColumnIdList,
  DRAFT_LOCKED_COLUMN_IDS,
  DRAFT_NON_SELECTABLE_COLUMN_IDS,
  isDraftColumnSelectable,
} from "../../utils/standardColumns";

function buildDraftSelectionSignature(vesselIds, columnIds) {
  const vessels = [...vesselIds].sort((a, b) => String(a).localeCompare(String(b))).join(",");
  const columns = [...columnIds].sort().join(",");
  return `${vessels}|${columns}`;
}

export default function ValidationView({ draftEmailId, refreshKey = 0, isActive = true }) {
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
  const [showAllColumns, setShowAllColumns] = useState(() => readPositionListShowAllColumnsPref());
  const [selectedColumnIds, setSelectedColumnIds] = useState(() => defaultDraftSelectedColumnIds());
  const [lastDraftSignature, setLastDraftSignature] = useState(null);
  const savedTimer                  = useRef(null);
  const draftSourceRef              = useRef({ vessels: [], columns: [] });

  const vesselsRef = useRef(vessels);
  useEffect(() => { vesselsRef.current = vessels; }, [vessels]);

  const load = useCallback(async () => {
    const hasExistingData = vesselsRef.current.length > 0;
    if (!hasExistingData) setLoading(true);
    setError("");
    try {
      const [vesselData, colData] = await Promise.all([
        getAllVesselsCombined(),
        getColumnDefinitions(),
      ]);
      setVessels(vesselData);
      setColumnDefs(colData.columns || []);
      setSelectedColumnIds(defaultDraftSelectedColumnIds(colData.columns || []));
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
      setLastDraftSignature(draftSourceRef.current.signature ?? null);
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

  const gridColumns = useMemo(
    () => filterPositionListGridColumns(columnDefs, showAllColumns),
    [columnDefs, showAllColumns],
  );

  const draftColumnIds = useMemo(
    () => buildDraftColumnIdList(selectedColumnIds, columnDefs),
    [selectedColumnIds, columnDefs],
  );

  const currentDraftSignature = useMemo(
    () => buildDraftSelectionSignature(selectedIds, draftColumnIds),
    [selectedIds, draftColumnIds],
  );

  const draftMatchesLastGeneration =
    lastDraftSignature !== null && lastDraftSignature === currentDraftSignature;

  useEffect(() => {
    if (!draftMatchesLastGeneration) {
      setDraftModalOpen(false);
    }
  }, [draftMatchesLastGeneration]);

  const toggleShowAllColumns = useCallback((next) => {
    setShowAllColumns((prev) => {
      const value = typeof next === "boolean" ? next : !prev;
      writePositionListShowAllColumnsPref(value);
      return value;
    });
  }, []);

  const handleToggleColumnSelect = useCallback((colId) => {
    if (DRAFT_LOCKED_COLUMN_IDS.has(colId) || DRAFT_NON_SELECTABLE_COLUMN_IDS.has(colId)) return;
    setSelectedColumnIds((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId);
      else next.add(colId);
      DRAFT_LOCKED_COLUMN_IDS.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const handleToggleVisibleColumnsForDraft = useCallback(() => {
    const visibleIds = gridColumns
      .map((c) => c.id)
      .filter((id) => isDraftColumnSelectable(id));
    setSelectedColumnIds((prev) => {
      const allVisible = visibleIds.length > 0 && visibleIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allVisible) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      DRAFT_LOCKED_COLUMN_IDS.forEach((id) => next.add(id));
      return next;
    });
  }, [gridColumns]);

  const draftableVisibleIds = useMemo(
    () => gridColumns.map((c) => c.id).filter((id) => isDraftColumnSelectable(id)),
    [gridColumns],
  );

  const allVisibleDraftSelected =
    draftableVisibleIds.length > 0 && draftableVisibleIds.every((id) => selectedColumnIds.has(id));
  const someVisibleDraftSelected = draftableVisibleIds.some((id) => selectedColumnIds.has(id));

  const fetchVesselSummary = useCallback(() => {
    const ids =
      selectedIds.size > 0
        ? [...selectedIds]
        : vessels.map((v) => v.id);
    return summarizeVessels(ids);
  }, [selectedIds, vessels]);

  const handleGenerateDraft = async () => {
    if (selectedIds.size === 0) return;
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
    const sourceVessels = vessels.filter((v) => selectedIds.has(v.id));
    const signature = buildDraftSelectionSignature(selectedIds, draftColumnIds);
    draftSourceRef.current = { vessels: sourceVessels, columns: draftColumnIds, signature };
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
      const { job_id } = await generateDraft(emailId, payload, draftColumnIds);
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

          {!loading && vessels.length > 0 && columnDefs.length > 0 && (
            <AllColumnsToggle
              enabled={showAllColumns}
              onChange={toggleShowAllColumns}
              visibleCount={gridColumns.length}
              totalCount={columnDefs.length}
            />
          )}

          <AiSummaryButton
            fetchSummary={fetchVesselSummary}
            title={
              selectedIds.size > 0
                ? `Vessel List — ${selectedIds.size} selected`
                : "Vessel Position List — AI Summary"
            }
            disabled={loading || vessels.length === 0}
          />

          <button
            onClick={handleGenerateDraft}
            disabled={
              generating
              || loading
              || vessels.length === 0
              || selectedIds.size === 0
              || draftMatchesLastGeneration
            }
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium transition-all shadow-sm bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-sky-600"
            title={
              selectedIds.size === 0
                ? "Select at least one vessel"
                : draftMatchesLastGeneration
                  ? "Draft already generated for this selection — change vessels or columns to regenerate"
                  : undefined
            }
          >
            {generating ? (
              <>
                <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Generating draft…
              </>
            ) : draftMatchesLastGeneration ? (
              `Draft generated — change selection to regenerate`
            ) : selectedIds.size > 0 ? (
              `Draft Email Position List — ${selectedIds.size} selected`
            ) : (
              `Draft Email Position List — select vessels`
            )}
          </button>

          {draftData && !generating && draftMatchesLastGeneration && (
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
          <ColumnsStat
            selectedCount={draftColumnIds.length}
            allVisibleDraftSelected={allVisibleDraftSelected}
            someVisibleDraftSelected={someVisibleDraftSelected}
            onToggleVisibleColumnsForDraft={handleToggleVisibleColumnsForDraft}
          />
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
      <div
        className="flex-1 min-h-0 px-3 py-2 overflow-hidden flex flex-col"
        style={{ background: "#f0f9ff" }}
      >
        {loading && vessels.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "#7dd3fc" }}>
            <span className="inline-block w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin mr-2" />
            Loading vessels…
          </div>
        ) : (
          <EditableGrid
            data={vessels}
            gridColumns={gridColumns}
            onCellEdit={handleCellEdit}
            readOnly
            showCheckboxes
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleAll={handleToggleAll}
            stretchToFill={!showAllColumns}
            isActive={isActive}
            showColumnSelect
            selectedColumnIds={selectedColumnIds}
            onToggleColumnSelect={handleToggleColumnSelect}
            emptyMessage="No verified vessels yet. Verify attachments on Email Extraction Inbox to add them here."
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

function ColumnsStat({
  selectedCount,
  allVisibleDraftSelected,
  someVisibleDraftSelected,
  onToggleVisibleColumnsForDraft,
}) {
  return (
    <label
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] shadow-sm cursor-pointer select-none"
      style={{ background: "#fff", border: "1px solid #bae6fd" }}
      title="Select all visible columns for draft email"
    >
      <input
        type="checkbox"
        checked={allVisibleDraftSelected}
        ref={(el) => {
          if (el) el.indeterminate = someVisibleDraftSelected && !allVisibleDraftSelected;
        }}
        onChange={onToggleVisibleColumnsForDraft}
        className="cursor-pointer accent-emerald-500"
      />
      <span style={{ color: "#7dd3fc" }}>Columns selected: </span>
      <span className="font-bold" style={{ color: "#0369a1" }}>{selectedCount}</span>
    </label>
  );
}
