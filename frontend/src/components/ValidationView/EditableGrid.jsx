import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import { Fragment, useMemo, useState, useRef, useEffect, useLayoutEffect } from "react";
import {
  DEFAULT_COLUMNS,
  enrichColumnDefs,
  minColumnWidthForHeader,
  resolveStandardCellValue,
  editFieldForColumn,
  isVesselNameColumn,
  isRegionColumn,
  isDraftColumnSelectable,
  DRAFT_LOCKED_COLUMN_IDS,
  SINGLE_LINE_COLUMN_IDS,
  hasDisplayValue,
} from "../../utils/standardColumns";
import { isAiNormalizedField } from "../../utils/fieldFormat";

const helper = createColumnHelper();

const GRID_BORDER = "1px solid var(--line)";

/** Checkbox (if shown), SR. NO, RECEIVED, and leading identity cols stay fixed when scrolling. */
function buildPinnedOrder(showCheckboxes) {
  const cols = ["_num", "received", "vessel_name", "imo", "region"];
  return showCheckboxes ? ["_select", ...cols] : cols;
}

function ReadOnlyCell({ getValue }) {
  const value = getValue() ?? "";
  return (
    <div
      className={`cell-val ${value ? "" : "is-empty"}`}
      title={value || ""}
    >
      {value || "—"}
    </div>
  );
}

function EditableCell({ getValue, row, column, table, vesselName = false, columnDefs }) {
  const initial = getValue() ?? "";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);
  const readOnly = table.options.meta?.readOnly;
  const editField = editFieldForColumn(column.id, columnDefs);

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  const commit = () => {
    setEditing(false);
    if (value !== initial && editField) {
      table.options.meta?.onCellEdit(row.original.id, editField, value);
    }
  };

  if (!editing || readOnly) {
    return (
      <div
        onClick={
          readOnly || !editField ? undefined : () => setEditing(true)
        }
        className={`cell-val ${value ? "" : "is-empty"} ${
          readOnly || !editField ? "cursor-default" : "cursor-text"
        } ${vesselName ? "font-bold uppercase" : ""}`}
        title={
          readOnly
            ? (value || "")
            : value || "Click to edit · Enter to save"
        }
      >
        {value || "—"}
      </div>
    );
  }

  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { commit(); table.options.meta?.onEnterSave?.(); }
        if (e.key === "Escape") { setValue(initial); setEditing(false); }
      }}
      className={`cell-edit ${vesselName ? "vname" : ""}`}
    />
  );
}

function EditableRegionCell({ getValue, row, column, table }) {
  const initial = getValue() ?? "";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);
  const readOnly = table.options.meta?.readOnly;

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  const commit = () => {
    setEditing(false);
    if (value !== initial) {
      table.options.meta?.onCellEdit(row.original.id, "__region__", value);
    }
  };

  if (!editing || readOnly) {
    return (
      <div
        onClick={readOnly ? undefined : () => setEditing(true)}
        className={`cell-val font-bold uppercase ${value ? "" : "is-empty"} ${
          readOnly ? "cursor-default" : "cursor-text"
        }`}
        style={value ? { color: "var(--brand-d)" } : undefined}
        title={readOnly ? (initial || "") : "Click to edit · Enter to save"}
      >
        {value || "—"}
      </div>
    );
  }

  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value.toUpperCase())}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { commit(); table.options.meta?.onEnterSave?.(); }
        if (e.key === "Escape") { setValue(initial); setEditing(false); }
      }}
      className="cell-edit region"
    />
  );
}

function SrNoCell({ row }) {
  return (
    <span className="cell-sr">
      {row.index + 1}
    </span>
  );
}

const COLUMN_SEARCH_DEBOUNCE_MS = 250;

function ColumnHeaderSearch({ label, value, onChange, onClear }) {
  const trimmed = String(value || "").trim();
  return (
    <div className={`col-hdr-search-wrap${trimmed ? " has-value" : ""}`}>
      <input
        type="search"
        className="col-hdr-search"
        placeholder="Search…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Search ${label}`}
      />
      {trimmed ? (
        <button
          type="button"
          className="col-hdr-search-clear"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          aria-label={`Clear ${label} search`}
          title="Clear this column"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export default function EditableGrid({
  data,
  columns: _legacyColumns,
  gridColumns,
  onCellEdit,
  onEnterSave,
  readOnly = false,
  showCheckboxes = false,
  hideGroupHeaders = false,
  groupHeaderIcon = "📎",
  emptyMessage = "No vessels loaded. Fetch emails on Email Extraction Inbox first.",
  selectedIds = new Set(),
  onToggleSelect,
  onToggleAll,
  stretchToFill = false,
  isActive = true,
  showColumnSelect = false,
  selectedColumnIds = new Set(),
  onToggleColumnSelect,
  columnWidthScale = 1,
  highlightEmpty = false,
  showColumnSearch = true,
}) {
  const scaleW = (w, header) =>
    Math.max(minColumnWidthForHeader(header), Math.max(48, Math.round(w * columnWidthScale)));
  const [containerWidth, setContainerWidth] = useState(0);
  const [columnSearchInput, setColumnSearchInput] = useState({});
  const [columnSearch, setColumnSearch] = useState({});
  const scrollRef = useRef(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setColumnSearch(columnSearchInput);
    }, COLUMN_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [columnSearchInput]);

  const measureContainer = () => {
    const el = scrollRef.current;
    if (!el) return;
    const w = el.clientWidth;
    if (w > 0) setContainerWidth(w);
  };

  useEffect(() => {
    if (!stretchToFill) {
      setContainerWidth(0);
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    measureContainer();
    const ro = new ResizeObserver(measureContainer);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stretchToFill, data.length]);

  useLayoutEffect(() => {
    if (stretchToFill && isActive) measureContainer();
  }, [stretchToFill, isActive, gridColumns]);

  const allSelected = showCheckboxes && data.length > 0 && data.every((v) => selectedIds.has(v.id));
  const someSelected = showCheckboxes && data.some((v) => selectedIds.has(v.id));

  const standardCols = useMemo(
    () => enrichColumnDefs(gridColumns?.length ? gridColumns : DEFAULT_COLUMNS),
    [gridColumns]
  );

  const hasActiveColumnSearch = useMemo(
    () => showColumnSearch && Object.values(columnSearch).some((v) => String(v || "").trim()),
    [showColumnSearch, columnSearch],
  );

  const hasColumnSearchInput = useMemo(
    () => showColumnSearch && Object.values(columnSearchInput).some((v) => String(v || "").trim()),
    [showColumnSearch, columnSearchInput],
  );

  const filteredData = useMemo(() => {
    if (!showColumnSearch || !hasActiveColumnSearch) return data;
    const active = Object.entries(columnSearch).filter(([, v]) => String(v || "").trim());
    return data.filter((row, rowIdx) =>
      active.every(([colId, rawQ]) => {
        const needle = String(rawQ).trim().toLowerCase();
        const cellVal = colId === "_num"
          ? String(rowIdx + 1)
          : resolveStandardCellValue(row, colId, rowIdx + 1);
        return String(cellVal ?? "").toLowerCase().includes(needle);
      }),
    );
  }, [data, columnSearch, showColumnSearch, hasActiveColumnSearch]);

  const clearColumnSearch = () => {
    setColumnSearchInput({});
    setColumnSearch({});
  };

  const setColumnSearchValue = (colId, value) => {
    setColumnSearchInput((prev) => {
      const next = { ...prev, [colId]: value };
      if (!String(value || "").trim()) delete next[colId];
      return next;
    });
  };

  const clearColumnSearchValue = (colId) => {
    setColumnSearchInput((prev) => {
      const next = { ...prev };
      delete next[colId];
      return next;
    });
    setColumnSearch((prev) => {
      const next = { ...prev };
      delete next[colId];
      return next;
    });
  };

  const groupCounts = useMemo(() => {
    const counts = new Map();
    filteredData.forEach((v) => {
      const id = v.attachment_id;
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    return counts;
  }, [filteredData]);

  const columnDefs = useMemo(() => {
    const cols = [];

    if (showCheckboxes) {
      cols.push(
        helper.display({
          id: "_select",
          size: 32,
          header: () => (
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
              onChange={() => onToggleAll?.()}
              title={allSelected ? "Deselect all" : "Select all"}
            />
          ),
          cell: (info) => (
            <input
              type="checkbox"
              checked={selectedIds.has(info.row.original.id)}
              onChange={() => onToggleSelect?.(info.row.original.id)}
            />
          ),
        })
      );
    }

    for (const col of standardCols) {
      const isReadOnly = col.read_only || col.id === "_num";
      const isRegion = isRegionColumn(col.id);
      const isName = isVesselNameColumn(col.id);

      if (col.id === "_num") {
        cols.push(
          helper.display({
            id: "_num",
            header: col.header,
            size: scaleW(col.width || 40, col.header),
            cell: (info) => <SrNoCell row={info.row} />,
          })
        );
        continue;
      }

      cols.push(
        helper.display({
          id: col.id,
          header: col.header,
          size: scaleW(col.width || 110, col.header),
          cell: (info) => {
            const value = resolveStandardCellValue(
              info.row.original,
              col.id,
              info.row.index + 1
            );
            if (isRegion) {
              return (
                <EditableRegionCell
                  {...info}
                  getValue={() => value}
                />
              );
            }
            if (isReadOnly) {
              return <ReadOnlyCell getValue={() => value} />;
            }
            if (isName) {
              return (
                <EditableCell
                  {...info}
                  getValue={() => value}
                  vesselName
                  columnDefs={standardCols}
                />
              );
            }
            return (
              <EditableCell
                {...info}
                getValue={() => value}
                columnDefs={standardCols}
              />
            );
          },
        })
      );
    }

    return cols;
  }, [
    standardCols,
    showCheckboxes,
    allSelected,
    someSelected,
    selectedIds,
    onToggleAll,
    onToggleSelect,
    columnWidthScale,
  ]);

  const table = useReactTable({
    data: filteredData,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    meta: { onCellEdit, onEnterSave, readOnly, columnDefs: standardCols, highlightEmpty },
  });

  const pinnedColIds = useMemo(
    () => new Set(buildPinnedOrder(showCheckboxes)),
    [showCheckboxes]
  );

  if (data.length === 0) {
    return (
      <div className="vessel-grid-empty">
        {emptyMessage}
      </div>
    );
  }

  const rows = table.getRowModel().rows;
  const headerGroup = table.getHeaderGroups()[0];
  const leafColumns = table.getVisibleLeafColumns();
  const colCount = leafColumns.length;

  const pinnedLeftById = (() => {
    const offsets = {};
    let left = 0;
    for (const col of leafColumns) {
      if (pinnedColIds.has(col.id)) {
        offsets[col.id] = left;
        left += col.columnDef.size || 100;
      }
    }
    return offsets;
  })();

  const pinnedLeafColumns = leafColumns.filter((col) => pinnedColIds.has(col.id));
  const firstPinnedId = pinnedLeafColumns[0]?.id;
  const lastPinnedId = pinnedLeafColumns.at(-1)?.id;
  const pinnedColCount = pinnedLeafColumns.length;
  const scrollColCount = colCount - pinnedColCount;

  const totalTableWidth = leafColumns.reduce(
    (sum, col) => sum + (col.columnDef.size || 100),
    0
  );

  const colWidth = (columnId) =>
    leafColumns.find((c) => c.id === columnId)?.columnDef.size || 100;

  const lastStretchableColumnId = (() => {
    for (let i = leafColumns.length - 1; i >= 0; i -= 1) {
      if (!pinnedColIds.has(leafColumns[i].id)) return leafColumns[i].id;
    }
    return null;
  })();

  const effectiveColWidth = (columnId) => {
    const base = colWidth(columnId);
    if (
      !stretchToFill
      || containerWidth <= 0
      || totalTableWidth >= containerWidth
      || columnId !== lastStretchableColumnId
    ) {
      return base;
    }
    const othersWidth = leafColumns.reduce(
      (sum, col) => sum + (col.id === lastStretchableColumnId ? 0 : colWidth(col.id)),
      0,
    );
    return Math.max(base, containerWidth - othersWidth);
  };

  const displayTableWidth =
    stretchToFill && containerWidth > totalTableWidth ? containerWidth : totalTableWidth;

  const pinnedTotalWidth = pinnedLeafColumns.reduce(
    (sum, col) => sum + effectiveColWidth(col.id),
    0,
  );

  const renderColumnHeader = (header) => {
    const colId = header.column.id;

    if (colId === "_select") {
      return (
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
          onChange={() => onToggleAll?.()}
          title={allSelected ? "Deselect all vessels" : "Select all vessels"}
        />
      );
    }

    const label = typeof header.column.columnDef.header === "string"
      ? header.column.columnDef.header
      : standardCols.find((c) => c.id === colId)?.header ?? colId;

    const searchable = showColumnSearch && colId !== "_select";
    const draftSelectable = showColumnSelect && isDraftColumnSelectable(colId);
    const draftLockedOn = showColumnSelect && DRAFT_LOCKED_COLUMN_IDS.has(colId);

    return (
      <div className={`col-hdr ${searchable ? "col-hdr-stack" : ""}`}>
        {draftSelectable ? (
          <>
            <div className="col-hdr-top">
              <input
                type="checkbox"
                className="draft-col-check"
                checked={selectedColumnIds.has(colId)}
                onChange={() => onToggleColumnSelect?.(colId)}
                title="Include in draft email"
              />
              <span className="col-hdr-label" title={label}>{label}</span>
            </div>
            {searchable && (
              <ColumnHeaderSearch
                label={label}
                value={columnSearchInput[colId] ?? ""}
                onChange={(v) => setColumnSearchValue(colId, v)}
                onClear={() => clearColumnSearchValue(colId)}
              />
            )}
          </>
        ) : draftLockedOn ? (
          <>
            <div className="col-hdr-top">
              <input
                type="checkbox"
                className="draft-col-check"
                checked
                readOnly
                onClick={(e) => e.preventDefault()}
                title="Always included in draft email"
              />
              <span className="col-hdr-label" title={label}>{label}</span>
            </div>
            {searchable && (
              <ColumnHeaderSearch
                label={label}
                value={columnSearchInput[colId] ?? ""}
                onChange={(v) => setColumnSearchValue(colId, v)}
                onClear={() => clearColumnSearchValue(colId)}
              />
            )}
          </>
        ) : (
          <>
            <span className="col-hdr-label" title={label}>{label}</span>
            {searchable && (
              <ColumnHeaderSearch
                label={label}
                value={columnSearchInput[colId] ?? ""}
                onChange={(v) => setColumnSearchValue(colId, v)}
                onClear={() => clearColumnSearchValue(colId)}
              />
            )}
          </>
        )}
      </div>
    );
  };

  const pinnedShadows = (columnId, bg) => {
    const parts = [];
    if (columnId === firstPinnedId) parts.push(`-12px 0 0 0 ${bg}`);
    if (columnId === lastPinnedId) parts.push("2px 0 6px rgba(7,38,56,0.06)");
    return parts.length ? { boxShadow: parts.join(", ") } : {};
  };

  const headerCellClass = (columnId) => {
    const parts = [];
    if (columnId === "_select") parts.push("col-select");
    if (columnId === "_num") parts.push("col-num");
    if (SINGLE_LINE_COLUMN_IDS.has(columnId)) parts.push("col-compact");
    if (
      showColumnSelect
      && (
        DRAFT_LOCKED_COLUMN_IDS.has(columnId)
        || (isDraftColumnSelectable(columnId) && selectedColumnIds.has(columnId))
      )
    ) {
      parts.push("draft-on");
    }
    return parts.join(" ");
  };

  const bodyCellClass = (columnId) => {
    if (columnId === "_select") return "cell-select";
    if (columnId === "_num") return "cell-num";
    if (columnId === "vessel_name") return "cell-vname";
    if (columnId === "region") return "cell-region";
    if (SINGLE_LINE_COLUMN_IDS.has(columnId)) return "cell-compact";
    return "";
  };

  const thStyle = (columnId) => {
    const w = effectiveColWidth(columnId);
    const pinned = pinnedLeftById[columnId];
    const isDraftOn = showColumnSelect && (
      DRAFT_LOCKED_COLUMN_IDS.has(columnId)
      || (isDraftColumnSelectable(columnId) && selectedColumnIds.has(columnId))
    );
    const headerBg = isDraftOn ? "var(--brand-d)" : "var(--brand)";
    return {
      width: w,
      minWidth: w,
      maxWidth: w,
      position: "sticky",
      top: 0,
      zIndex: pinned != null ? 55 : 40,
      background: headerBg,
      ...(pinned != null ? { left: pinned } : {}),
      ...(columnId === firstPinnedId ? { borderLeft: GRID_BORDER } : {}),
      ...(pinned != null ? pinnedShadows(columnId, headerBg) : {}),
    };
  };

  const tdStyle = (columnId, { missing = false, aiNormalized = false } = {}) => {
    const w = effectiveColWidth(columnId);
    const pinned = pinnedLeftById[columnId];
    const bg = missing ? "#fffef8" : aiNormalized ? "#fff8f8" : "#fff";
    const pinShadow = pinned != null ? pinnedShadows(columnId, bg) : {};
    const ring = missing
      ? "inset 0 0 0 2px #F8F4D9"
      : aiNormalized
        ? "inset 0 0 0 2px #FBDCDB"
        : "";
    const boxShadow = [pinShadow.boxShadow, ring].filter(Boolean).join(", ") || undefined;
    return {
      width: w,
      minWidth: w,
      maxWidth: w,
      ...((missing || aiNormalized) ? { background: bg, borderRadius: 0 } : {}),
      ...(boxShadow ? { boxShadow } : {}),
      ...(pinned != null
        ? {
            position: "sticky",
            left: pinned,
            zIndex: columnId === "_select" ? 26 : 25,
            ...(columnId === firstPinnedId ? { borderLeft: GRID_BORDER } : {}),
            background: bg,
          }
        : {}),
    };
  };

  return (
    <div className="vessel-grid-wrap">
      {(hasActiveColumnSearch || hasColumnSearchInput) && (
        <div className="col-search-bar">
          <span>
            Showing {filteredData.length} of {data.length} row{data.length !== 1 ? "s" : ""}
            {filteredData.length === 0 ? " — no matches" : ""}
          </span>
          <button type="button" className="col-search-clear" onClick={clearColumnSearch}>
            Clear all filters
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        className={`vessel-grid-scroll ${stretchToFill ? "stretch" : ""}`}
      >
        <table
          className="vessel-grid"
          style={{
            tableLayout: "fixed",
            width: displayTableWidth,
            minWidth: displayTableWidth,
          }}
        >
          <colgroup>
            {leafColumns.map((col) => (
              <col key={col.id} style={{ width: effectiveColWidth(col.id) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  style={thStyle(header.column.id)}
                  className={headerCellClass(header.column.id)}
                >
                  {renderColumnHeader(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr className="grid-empty-row">
                <td colSpan={colCount} className="grid-no-match">
                  No rows match the column search filters.
                </td>
              </tr>
            ) : (
            rows.map((row, i) => {
              const currentAttId = row.original.attachment_id;
              const prevAttId = i > 0 ? rows[i - 1].original.attachment_id : null;
              const isNewGroup = currentAttId !== prevAttId;
              const filename = (row.original.filename || currentAttId || "Unknown Source")
                .replace(/\.eml$/i, "");
              const groupVesselCount = groupCounts.get(currentAttId) || 0;

              return (
                <Fragment key={row.id}>
                  {isNewGroup && !hideGroupHeaders && (
                    <tr className="grp-row">
                      <td
                        colSpan={pinnedColCount}
                        style={{
                          position: "sticky",
                          left: 0,
                          zIndex: 31,
                          width: pinnedTotalWidth,
                          minWidth: pinnedTotalWidth,
                          maxWidth: pinnedTotalWidth,
                          overflow: "hidden",
                          borderLeft: GRID_BORDER,
                          boxShadow: pinnedColCount > 0
                            ? "-12px 0 0 0 var(--brand-50), 2px 0 6px rgba(7,38,56,0.06)"
                            : undefined,
                        }}
                      >
                        <span
                          className="grp-label"
                          title={`${filename} (${groupVesselCount} vessel${groupVesselCount !== 1 ? "s" : ""})`}
                        >
                          {groupHeaderIcon ? <span className="grp-icon">{groupHeaderIcon}</span> : null}
                          <span>{filename}</span>
                          <span className="grp-count">
                            ({groupVesselCount} vessel{groupVesselCount !== 1 ? "s" : ""})
                          </span>
                        </span>
                      </td>
                      {scrollColCount > 0 ? (
                        <td colSpan={scrollColCount} />
                      ) : null}
                    </tr>
                  )}
                  <tr>
                    {row.getVisibleCells().map((cell) => {
                      const colId = cell.column.id;
                      const raw = resolveStandardCellValue(
                        row.original,
                        colId,
                        row.index + 1
                      );
                      const canEdit =
                        colId === "region" || Boolean(editFieldForColumn(colId, standardCols));
                      const isMissing =
                        highlightEmpty
                        && canEdit
                        && !hasDisplayValue(raw);
                      const isAiNorm =
                        !isMissing && isAiNormalizedField(row.original, colId);
                      return (
                        <td
                          key={cell.id}
                          style={tdStyle(colId, {
                            missing: isMissing,
                            aiNormalized: isAiNorm,
                          })}
                          className={[
                            bodyCellClass(colId),
                            isMissing ? "cell-missing" : "",
                            isAiNorm ? "cell-ai-norm" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                  </tr>
                </Fragment>
              );
            })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
