import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { getAllVesselsCombined, getColumnDefinitions, updateVessel, deleteVessel, generateDraft, createManualVessel } from "../../services/api";
import { useSSE } from "../../hooks/useSSE";
import EditableGrid from "./EditableGrid";
import DraftModal from "./DraftModal";
import AllColumnsToggle from "./AllColumnsToggle";
import Icon from "../icons";
import {
  filterPositionListGridColumns,
  readPositionListShowAllColumnsPref,
  writePositionListShowAllColumnsPref,
  defaultDraftSelectedColumnIds,
  buildDraftColumnIdList,
  DRAFT_LOCKED_COLUMN_IDS,
  DRAFT_NON_SELECTABLE_COLUMN_IDS,
  isDraftColumnSelectable,
  sortVesselsBySourceOrder,
} from "../../utils/standardColumns";
import { formatStandardField, formatDwtSdwt, formatCbm, formatYearBuilt, parseAiNormalized, formatAiNormalized } from "../../utils/fieldFormat";
import RegionSelect from "../RegionSelect";
import VesselTypeSelect, { isImoTypeValue } from "../VesselTypeSelect";
import CellHighlightLegend from "../CellHighlightLegend";

const RECEIVED_COL = { id: "received", header: "RECEIVED", read_only: true, storage: "derived" };

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
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [selectedColumnIds, setSelectedColumnIds] = useState(() => defaultDraftSelectedColumnIds());
  const [lastDraftSignature, setLastDraftSignature] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const savedTimer                  = useRef(null);
  const draftSourceRef              = useRef({ vessels: [], columns: [] });
  const dirtyRef                    = useRef(new Set());
  const editSnapshot                = useRef(null);

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
      setVessels(sortVesselsBySourceOrder(vesselData));
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

  // Whenever the Position List is shown / columns resolve, auto-check default draft columns.
  useEffect(() => {
    if (!columnDefs?.length) return;
    setSelectedColumnIds(defaultDraftSelectedColumnIds(columnDefs));
  }, [columnDefs]);

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

  const handleCellEdit = useCallback((rowId, field, value) => {
    if (!editMode) return;
    if (field === "signature_emails" || field === "signature_phones") return;
    const next = vesselsRef.current.map((v) => {
      if (v.id !== rowId) return v;
      if (field === "__region__") return { ...v, region: value };
      const dd = { ...v.dynamic_data };
      if (field === "dwt_sdwt" || field === "dwt" || field === "sdwt") {
        const { value: stored, scaled } = formatDwtSdwt(value);
        dd[field === "dwt_sdwt" ? "dwt_sdwt" : field] = stored || value;
        if (field !== "dwt_sdwt") dd.dwt_sdwt = stored || value;
        const flags = parseAiNormalized(dd.ai_normalized);
        if (scaled) flags.add("dwt_sdwt");
        else flags.delete("dwt_sdwt");
        dd.ai_normalized = formatAiNormalized(flags);
      } else if (field === "cbm") {
        const { value: stored, scaled } = formatCbm(value);
        dd.cbm = stored || value;
        const flags = parseAiNormalized(dd.ai_normalized);
        if (scaled) flags.add("cbm");
        else flags.delete("cbm");
        dd.ai_normalized = formatAiNormalized(flags);
      } else if (field === "year_built" || field === "built") {
        const { value: stored, expanded } = formatYearBuilt(value);
        dd.year_built = stored || value;
        const flags = parseAiNormalized(dd.ai_normalized);
        if (expanded) flags.add("year_built");
        else flags.delete("year_built");
        dd.ai_normalized = formatAiNormalized(flags);
      } else {
        const stored = formatStandardField(field, value);
        dd[field] = stored || value;
      }
      return { ...v, dynamic_data: dd };
    });
    vesselsRef.current = next;
    setVessels(next);
    dirtyRef.current.add(rowId);
  }, [editMode]);

  const enterEditMode = useCallback(() => {
    editSnapshot.current = vesselsRef.current;
    dirtyRef.current = new Set();
    setError("");
    setEditMode(true);
  }, []);

  const cancelEditMode = useCallback(() => {
    if (editSnapshot.current) {
      vesselsRef.current = editSnapshot.current;
      setVessels(editSnapshot.current);
    }
    dirtyRef.current = new Set();
    setEditMode(false);
  }, []);

  const handleSaveEdits = useCallback(async () => {
    const ids = [...dirtyRef.current];
    if (ids.length === 0) {
      setEditMode(false);
      return;
    }
    setEditSaving(true);
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
      setEditMode(false);
      editSnapshot.current = null;
      flashSaved();
    } catch (e) {
      setError("Failed to save: " + e.message);
    } finally {
      setEditSaving(false);
    }
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
    const n = selectedIds.size;
    const ok = window.confirm(
      n === 1
        ? "Delete this vessel position? This cannot be undone."
        : `Delete ${n} selected vessel positions? This cannot be undone.`,
    );
    if (!ok) return;
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

  const regionOptions = useMemo(() => {
    const set = new Set();
    vessels.forEach((v) => { const r = (v.region || "").trim(); if (r) set.add(r); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [vessels]);

  const visibleVessels = useMemo(() => {
    const fromTs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toTs = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;
    const filtered = vessels.filter((v) => {
      if (regionFilter && (v.region || "").trim() !== regionFilter) return false;
      if (fromTs != null || toTs != null) {
        const t = v.date_received ? new Date(v.date_received).getTime() : NaN;
        if (isNaN(t)) return false;
        if (fromTs != null && t < fromTs) return false;
        if (toTs != null && t > toTs) return false;
      }
      return true;
    });
    return sortVesselsBySourceOrder(filtered);
  }, [vessels, dateFrom, dateTo, regionFilter]);

  const filtersActive = Boolean(dateFrom || dateTo || regionFilter);
  const clearFilters = useCallback(() => { setDateFrom(""); setDateTo(""); setRegionFilter(""); }, []);

  // Keep the selection limited to rows currently visible under the filters.
  useEffect(() => {
    const visibleIds = new Set(visibleVessels.map((v) => v.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set();
      prev.forEach((id) => { if (visibleIds.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [visibleVessels]);

  const handleToggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allSelected = visibleVessels.length > 0 && visibleVessels.every((v) => prev.has(v.id));
      if (allSelected) return new Set();
      return new Set(visibleVessels.map((v) => v.id));
    });
  }, [visibleVessels]);

  const sourceCount = new Set(visibleVessels.map((v) => v.attachment_id).filter(Boolean)).size;

  const gridColumns = useMemo(() => {
    const base = filterPositionListGridColumns(columnDefs, showAllColumns);
    const out = [...base];
    const numIdx = out.findIndex((c) => c.id === "_num");
    out.splice(numIdx >= 0 ? numIdx + 1 : 0, 0, RECEIVED_COL);
    return out;
  }, [columnDefs, showAllColumns]);

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

  const handleGenerateDraft = async () => {
    if (selectedIds.size === 0) return;
    const emailId =
      draftEmailId ||
      visibleVessels.find((v) => v.parent_email_id)?.parent_email_id;
    if (!emailId) {
      setError("No validation-ready email found for draft generation.");
      return;
    }
    setGenerating(true);
    setError("");
    setDraftData(null);
    setDraftModalOpen(false);
    const sourceVessels = visibleVessels.filter((v) => selectedIds.has(v.id));
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
        <div className="vgrid-title">
          <h2>Vessel Position List</h2>
          <span className="vgrid-sub">
            Select vessel and click on draft mail, your position list is ready to send
          </span>
        </div>

        <div className="vgrid-actions">
          <span className={`vgrid-saved ${savedMsg ? "show" : ""}`}>✓ Saved</span>

          {!loading && vessels.length > 0 && selectedIds.size > 0 && !editMode && (
            <button
              type="button"
              className="tb-btn tb-btn-sm vgrid-delete-btn"
              onClick={handleDeleteSelected}
              title="Delete selected vessel positions"
            >
              <Icon name="trash" size={13} />
              <span className="vgrid-delete-label">
                Delete{selectedIds.size > 1 ? ` (${selectedIds.size})` : ""}
              </span>
            </button>
          )}

          {!loading && vessels.length > 0 && (
            editMode ? (
              <>
                <button
                  type="button"
                  className="btn-save-changes"
                  onClick={handleSaveEdits}
                  disabled={editSaving}
                >
                  {editSaving ? <><span className="spin-ring" /> Saving…</> : "Save changes"}
                </button>
                <button
                  type="button"
                  className="btn-cancel-edit"
                  onClick={cancelEditMode}
                  disabled={editSaving}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-edit"
                onClick={enterEditMode}
                title="Edit vessel fields"
              >
                ✎ Edit
              </button>
            )
          )}

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
              visibleCount={gridColumns.length - 1}
              totalCount={columnDefs.length}
            />
          )}

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
            className="btn btn-send vgrid-draft-btn"
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
          <Stat label="Vessels" value={visibleVessels.length} />
          <Stat label="Emails" value={sourceCount} />
          <Stat label="Regions" value={new Set(visibleVessels.map((v) => v.region).filter(Boolean)).size} />
          <ColumnsStat
            selectedCount={draftColumnIds.length}
            allVisibleDraftSelected={allVisibleDraftSelected}
            someVisibleDraftSelected={someVisibleDraftSelected}
            onToggleVisibleColumnsForDraft={handleToggleVisibleColumnsForDraft}
          />
        </div>
      )}

      {vessels.length > 0 && (
        <div className="vgrid-filters">
          <div className="vf-group">
            <label className="vf-label">EMAIL DATE RANGE</label>
            <div className="vf-dates">
              <input
                type="date"
                className="vf-input"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(e) => setDateFrom(e.target.value)}
              />
              <span className="vf-dash">–</span>
              <input
                type="date"
                className="vf-input"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
          </div>

          <div className="vf-group">
            <label className="vf-label">REGION</label>
            <select
              className="vf-input vf-select"
              value={regionFilter}
              onChange={(e) => setRegionFilter(e.target.value)}
            >
              <option value="">All regions</option>
              {regionOptions.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="tb-btn vf-clear"
            onClick={clearFilters}
            disabled={!filtersActive}
          >
            Clear filters
          </button>

          <CellHighlightLegend />
        </div>
      )}

      {error && <div className="vgrid-err">{error}</div>}

      <div className="vgrid-body">
        {loading && vessels.length === 0 ? (
          <div className="center-load"><span className="spin-ring" /> Loading vessels…</div>
        ) : (
          <EditableGrid
            data={visibleVessels}
            gridColumns={gridColumns}
            onCellEdit={handleCellEdit}
            onEnterSave={handleSaveEdits}
            readOnly={!editMode}
            highlightEmpty={editMode}
            showCheckboxes
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleAll={handleToggleAll}
            stretchToFill={!showAllColumns}
            isActive={isActive}
            showColumnSelect
            selectedColumnIds={selectedColumnIds}
            onToggleColumnSelect={handleToggleColumnSelect}
            emptyMessage={
              filtersActive
                ? "No vessels match the current filters."
                : "No vessels yet. Sync owner emails from Inbox to populate the list."
            }
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
  const [showAllFields, setShowAllFields] = useState(false);
  const [form, setForm] = useState(() =>
    columns.reduce((acc, c) => ({ ...acc, [fieldKey(c)]: "" }), {})
  );

  const visibleColumns = useMemo(() => {
    // Same order/default as Position List (skip SR. NO — form-only fields).
    const ordered = filterPositionListGridColumns(columns, showAllFields)
      .filter((c) => c.id !== "_num" && c.storage !== "derived");
    return ordered;
  }, [columns, showAllFields]);

  const editableTotal = useMemo(
    () => columns.filter((c) => c.id !== "_num" && c.storage !== "derived").length,
    [columns],
  );

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const submit = (e) => {
    e.preventDefault();
    if (saving) return;
    const cleaned = { ...form };
    let vt = String(cleaned.vessel_type || "").trim();
    if (vt === "Others" || isImoTypeValue(vt)) vt = "";
    cleaned.vessel_type = vt;
    onSave(cleaned);
  };

  return createPortal(
    <div className="vlib-modal-bg" onClick={(e) => e.target.classList.contains("vlib-modal-bg") && onClose()}>
      <form className="vlib-modal" onSubmit={submit}>
        <div className="vlib-modal-head">
          <h3>Add position</h3>
          <button type="button" className="vlib-modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="vlib-modal-toolbar">
          <p className="vlib-modal-note">
            Same default columns as the position list. Turn on All columns to fill extra fields.
          </p>
          <AllColumnsToggle
            enabled={showAllFields}
            onChange={setShowAllFields}
            visibleCount={visibleColumns.length}
            totalCount={editableTotal}
          />
        </div>
        <div className="vlib-modal-grid">
          {visibleColumns.map((c) => {
            const key = fieldKey(c);
            if (c.storage === "region" || c.id === "region") {
              return (
                <label key={c.id} className="vlib-field">
                  <span>{c.header}</span>
                  <RegionSelect
                    value={form[key] || ""}
                    onChange={(val) => set(key, val)}
                    fieldSize
                  />
                </label>
              );
            }
            if (c.id === "vessel_type") {
              return (
                <label key={c.id} className="vlib-field">
                  <span>{c.header}</span>
                  <VesselTypeSelect
                    value={form[key] || ""}
                    onChange={(val) => set(key, val)}
                    fieldSize
                  />
                </label>
              );
            }
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
