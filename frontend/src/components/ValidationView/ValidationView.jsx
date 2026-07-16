import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { getAllVesselsCombined, getColumnDefinitions, updateVessel, deleteVessel, generateDraft, createManualVessel } from "../../services/api";
import { useSSE } from "../../hooks/useSSE";
import EditableGrid from "./EditableGrid";
import DraftModal from "./DraftModal";
import AllColumnsToggle from "./AllColumnsToggle";
import AiSummaryButton from "../AiSummary/AiSummaryButton";
import Icon from "../icons";
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
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
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

  const handleAddPosition = useCallback(async (form) => {
    setAddSaving(true);
    setError("");
    const region = (form.__region__ || "").trim();
    const dynamicData = {};
    Object.entries(form).forEach(([k, v]) => {
      if (k !== "__region__") dynamicData[k] = (v || "").trim();
    });
    try {
      await createManualVessel(dynamicData, region);
      setAddModalOpen(false);
      flashSaved();
      await load();
    } catch (e) {
      setError("Failed to add position: " + e.message);
    } finally {
      setAddSaving(false);
    }
  }, [load]);

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

  const manualColumns = useMemo(
    () => (columnDefs || []).filter((c) => c.storage && c.storage !== "derived"),
    [columnDefs],
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
    <div className="vgrid-root">

      <div className="vgrid-head">
        <h2>Vessel Position List</h2>

        <div className="vgrid-actions">
          <span className={`vgrid-saved ${savedMsg ? "show" : ""}`}>✓ Saved</span>

          <button
            type="button"
            className="tb-btn tb-btn-primary tb-btn-sm"
            onClick={() => setAddModalOpen(true)}
            disabled={loading || columnDefs.length === 0}
          >
            <Icon name="plus" size={13} /> Add position
          </button>

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
            className="tb-btn"
          />

          <button
            type="button"
            onClick={handleGenerateDraft}
            disabled={
              generating
              || loading
              || vessels.length === 0
              || selectedIds.size === 0
              || draftMatchesLastGeneration
            }
            className="btn btn-send"
            style={{ fontSize: 13, padding: "9px 15px" }}
            title={
              selectedIds.size === 0
                ? "Select at least one vessel"
                : draftMatchesLastGeneration
                  ? "Draft already generated for this selection — change vessels or columns to regenerate"
                  : undefined
            }
          >
            {generating ? (
              <><span className="spin-ring" /> Generating draft…</>
            ) : draftMatchesLastGeneration ? (
              "Draft generated — change selection"
            ) : selectedIds.size > 0 ? (
              `Draft Email — ${selectedIds.size} selected`
            ) : (
              "Draft Email — select vessels"
            )}
          </button>

          {draftData && !generating && draftMatchesLastGeneration && (
            <button
              type="button"
              onClick={() => setDraftModalOpen(true)}
              className="btn btn-ghost"
              style={{ fontSize: 13, padding: "9px 15px" }}
            >
              ✓ View Map &amp; Draft
            </button>
          )}
        </div>
      </div>

      {vessels.length > 0 && (
        <div className="vgrid-stats">
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

      {error && <div className="vgrid-err">{error}</div>}

      <div className="vgrid-body">
        {loading && vessels.length === 0 ? (
          <div className="center-load"><span className="spin-ring" /> Loading vessels…</div>
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
            emptyMessage="No vessels yet. Sync owner emails from Inbox to populate the list."
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

      {addModalOpen && (
        <AddPositionModal
          columns={manualColumns}
          saving={addSaving}
          onClose={() => setAddModalOpen(false)}
          onSave={handleAddPosition}
        />
      )}
    </div>
  );
}

function AddPositionModal({ columns, saving, onClose, onSave }) {
  const fieldKey = (c) => (c.storage === "region" ? "__region__" : c.id);
  const [form, setForm] = useState(() =>
    columns.reduce((acc, c) => ({ ...acc, [fieldKey(c)]: "" }), {})
  );

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const submit = (e) => {
    e.preventDefault();
    if (saving) return;
    onSave(form);
  };

  return createPortal(
    <div className="vlib-modal-bg" onClick={(e) => e.target.classList.contains("vlib-modal-bg") && onClose()}>
      <form className="vlib-modal" onSubmit={submit}>
        <div className="vlib-modal-head">
          <h3>Add position</h3>
          <button type="button" className="vlib-modal-x" onClick={onClose}>✕</button>
        </div>
        <p className="vlib-modal-note">New entry with the same columns as the position list. Fill what you have and save.</p>
        <div className="vlib-modal-grid">
          {columns.map((c) => {
            const key = fieldKey(c);
            return (
              <label key={c.id} className="vlib-field">
                <span>{c.header}</span>
                <input
                  value={form[key] || ""}
                  onChange={(e) => set(key, e.target.value)}
                  autoFocus={c.id === "vessel_name"}
                />
              </label>
            );
          })}
        </div>
        <div className="vlib-modal-btns">
          <button type="button" className="tb-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="tb-btn tb-btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Save position"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}

function Stat({ label, value }) {
  return (
    <div className="vgrid-stat">
      <span>{label}: </span>
      <b>{value}</b>
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
      className="vgrid-stat"
      title="Select all visible columns for draft email"
    >
      <input
        type="checkbox"
        checked={allVisibleDraftSelected}
        ref={(el) => {
          if (el) el.indeterminate = someVisibleDraftSelected && !allVisibleDraftSelected;
        }}
        onChange={onToggleVisibleColumnsForDraft}
        className="cursor-pointer accent-[var(--brand)]"
      />
      <span>Columns selected: </span>
      <b>{selectedCount}</b>
    </label>
  );
}
