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
  resolveStandardCellValue,
  editFieldForColumn,
  isVesselNameColumn,
  isRegionColumn,
  isDraftColumnSelectable,
} from "../../utils/standardColumns";

const helper = createColumnHelper();

const GRID_BORDER = "1px solid #94a3b8";

/** Checkbox (if shown), SR. NO, IMO, VESSEL NAME, REGION stay fixed when scrolling. */
function buildPinnedOrder(showCheckboxes) {
  const cols = ["_num", "imo", "vessel_name", "region"];
  return showCheckboxes ? ["_select", ...cols] : cols;
}

function ReadOnlyCell({ getValue }) {
  const value = getValue() ?? "";
  return (
    <div
      className="px-1.5 py-0.5 text-[11px] leading-snug max-w-[min(260px,32vw)] whitespace-normal break-words"
      style={{ color: value ? "#0c4a6e" : "#94a3b8", fontStyle: value ? "normal" : "italic" }}
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

  const commit = () => {
    setEditing(false);
    if (value !== initial && editField) {
      table.options.meta?.onCellEdit(row.original.id, editField, value);
    }
  };

  if (!editing || readOnly) {
    return (
      <div
        onDoubleClick={
          readOnly || !editField ? undefined : () => setEditing(true)
        }
        className={`px-1.5 py-0.5 min-h-[20px] text-[11px] leading-snug whitespace-normal break-words w-full ${
          vesselName ? "font-bold" : ""
        } ${readOnly || !editField ? "cursor-default" : "cursor-text"}`}
        style={{
          color: value ? "#0c4a6e" : "#94a3b8",
          fontStyle: value ? "normal" : "italic",
        }}
        title={readOnly ? value || "" : value || "Double-click to edit · Enter to save"}
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
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setValue(initial); setEditing(false); }
      }}
      className={`w-full px-1.5 py-0.5 bg-sky-50 border border-sky-400 rounded text-[11px] text-sky-800 outline-none ${
        vesselName ? "min-w-[140px] font-bold" : "min-w-[72px]"
      }`}
    />
  );
}

function EditableRegionCell({ getValue, row, column, table }) {
  const initial = getValue() ?? "";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);
  const readOnly = table.options.meta?.readOnly;

  const commit = () => {
    setEditing(false);
    if (value !== initial) {
      table.options.meta?.onCellEdit(row.original.id, "__region__", value);
    }
  };

  if (!editing || readOnly) {
    return (
      <div
        onDoubleClick={readOnly ? undefined : () => setEditing(true)}
        className={`px-1.5 py-0.5 text-[11px] font-semibold whitespace-normal break-words ${
          readOnly ? "cursor-default" : "cursor-text"
        }`}
        style={{ color: "#0369a1" }}
        title={readOnly ? initial || "" : "Double-click to edit · Enter to save"}
      >
        {value || <span style={{ color: "#94a3b8", fontWeight: "normal", fontStyle: "italic" }}>—</span>}
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
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setValue(initial); setEditing(false); }
      }}
      className="w-full min-w-[100px] px-1.5 py-0.5 bg-sky-50 border border-sky-400 rounded text-[11px] text-sky-800 outline-none uppercase font-semibold"
    />
  );
}

function SrNoCell({ row }) {
  return (
    <span className="text-[11px] pl-1 font-medium tabular-nums" style={{ color: "#475569" }}>
      {row.index + 1}
    </span>
  );
}

export default function EditableGrid({
  data,
  columns: _legacyColumns,
  gridColumns,
  onCellEdit,
  readOnly = false,
  showCheckboxes = false,
  hideGroupHeaders = false,
  groupHeaderIcon = "📎",
  emptyMessage = "No vessels loaded. Fetch emails on Email Data first.",
  selectedIds = new Set(),
  onToggleSelect,
  onToggleAll,
  stretchToFill = false,
  isActive = true,
  showColumnSelect = false,
  selectedColumnIds = new Set(),
  onToggleColumnSelect,
}) {
  const [hoveredRowId, setHoveredRowId] = useState(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const scrollRef = useRef(null);

  const measureContainer = () => {
    const el = scrollRef.current;
    if (!el) return;
    const w = el.clientWidth;
    if (w > 0) setContainerWidth(w);
  };

  const groupCounts = useMemo(() => {
    const counts = new Map();
    data.forEach((v) => {
      const id = v.attachment_id;
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    return counts;
  }, [data]);

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
              className="cursor-pointer accent-sky-500"
              title={allSelected ? "Deselect all" : "Select all"}
            />
          ),
          cell: (info) => (
            <input
              type="checkbox"
              checked={selectedIds.has(info.row.original.id)}
              onChange={() => onToggleSelect?.(info.row.original.id)}
              className="cursor-pointer accent-sky-500"
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
            size: col.width || 40,
            cell: (info) => <SrNoCell row={info.row} />,
          })
        );
        continue;
      }

      cols.push(
        helper.display({
          id: col.id,
          header: col.header,
          size: col.width || 110,
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
  ]);

  const table = useReactTable({
    data,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    meta: { onCellEdit, readOnly, columnDefs: standardCols },
  });

  const pinnedColIds = useMemo(
    () => new Set(buildPinnedOrder(showCheckboxes)),
    [showCheckboxes]
  );

  const headerStyle = {
    background: "#0369a1",
    color: "#e0f2fe",
    border: GRID_BORDER,
    fontWeight: 600,
  };

  const tableStyle = {
    borderCollapse: "separate",
    borderSpacing: 0,
    borderTop: GRID_BORDER,
    borderRight: GRID_BORDER,
    borderBottom: GRID_BORDER,
    borderLeft: "none",
  };

  if (data.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm italic text-center px-4" style={{ color: "#7dd3fc" }}>
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
  const GROUP_HEADER_BG = "#dbeafe";

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

  /** Summary view: only the last scrollable column grows — keeps widths stable when toggling all columns. */
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
          className="cursor-pointer accent-sky-300"
          title={allSelected ? "Deselect all vessels" : "Select all vessels"}
        />
      );
    }

    const label = typeof header.column.columnDef.header === "string"
      ? header.column.columnDef.header
      : standardCols.find((c) => c.id === colId)?.header ?? colId;

    if (!showColumnSelect || !isDraftColumnSelectable(colId)) {
      return label;
    }

    const checked = selectedColumnIds.has(colId);

    return (
      <div className="flex items-start gap-1 min-w-0">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggleColumnSelect?.(colId)}
          className="mt-0.5 shrink-0 cursor-pointer accent-emerald-300"
          title="Include in draft email"
        />
        <span className="truncate leading-tight" title={label}>
          {label}
        </span>
      </div>
    );
  };

  /** Extends sticky cell paint to the left edge so scrolled content cannot peek through. */
  const pinnedShadows = (columnId, bg) => {
    const parts = [];
    if (columnId === firstPinnedId) parts.push(`-12px 0 0 0 ${bg}`);
    if (columnId === lastPinnedId) parts.push("2px 0 6px rgba(0,0,0,0.08)");
    return parts.length ? { boxShadow: parts.join(", ") } : {};
  };

  const thStyle = (columnId) => {
    const w = effectiveColWidth(columnId);
    const pinned = pinnedLeftById[columnId];
    const draftOn =
      showColumnSelect
      && isDraftColumnSelectable(columnId)
      && selectedColumnIds.has(columnId);
    const bg = draftOn ? "#0284c7" : headerStyle.background;
    return {
      ...headerStyle,
      width: w,
      minWidth: w,
      maxWidth: w,
      boxSizing: "border-box",
      position: "sticky",
      top: 0,
      zIndex: pinned != null ? 55 : 40,
      ...(pinned != null ? { left: pinned } : {}),
      ...(columnId === firstPinnedId ? { borderLeft: GRID_BORDER } : {}),
      ...(pinned != null ? pinnedShadows(columnId, bg) : {}),
      ...(columnId === "_num" ? { paddingLeft: 8 } : {}),
    };
  };

  const tdStyle = (columnId, rowBg, rowId) => {
    const w = effectiveColWidth(columnId);
    const pinned = pinnedLeftById[columnId];
    const isVesselName = columnId === "vessel_name";
    const bg = isVesselName
      ? hoveredRowId === rowId ? "#dbeafe" : "#eff6ff"
      : rowBg;
    return {
      border: GRID_BORDER,
      width: w,
      minWidth: w,
      maxWidth: w,
      boxSizing: "border-box",
      background: bg,
      ...(columnId === "_num" ? { paddingLeft: 8 } : {}),
      ...(pinned != null
        ? {
            position: "sticky",
            left: pinned,
            zIndex: columnId === "_select" ? 26 : 25,
            ...(columnId === firstPinnedId ? { borderLeft: GRID_BORDER } : {}),
            ...pinnedShadows(columnId, bg),
          }
        : {}),
    };
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 rounded-lg shadow-sm" style={{ border: GRID_BORDER, background: "#fff" }}>
      <div
        ref={scrollRef}
        className="overflow-auto flex-1 min-h-0 overscroll-contain"
        style={{ background: stretchToFill ? "#f0f9ff" : "#fff" }}
      >
        <table
          className="text-[11px] leading-tight bg-white"
          style={{
            ...tableStyle,
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
                  className={`py-1.5 text-[11px] select-none ${
                    header.id === "_select" ? "text-center px-1.5" : header.id === "_num" ? "text-left pr-1.5" : "text-left px-1.5"
                  } ${header.id === "_select" || showColumnSelect ? "" : "whitespace-nowrap"}`}
                >
                  {renderColumnHeader(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const currentAttId = row.original.attachment_id;
              const prevAttId = i > 0 ? rows[i - 1].original.attachment_id : null;
              const isNewGroup = currentAttId !== prevAttId;
              const filename = (row.original.filename || currentAttId || "Unknown Source")
                .replace(/\.eml$/i, "");
              const groupVesselCount = groupCounts.get(currentAttId) || 0;
              const rowBg =
                hoveredRowId === row.id ? "#e0f2fe" : i % 2 === 0 ? "#ffffff" : "#f1f5f9";

              return (
                <Fragment key={row.id}>
                  {isNewGroup && !hideGroupHeaders && (
                    <tr style={{ background: GROUP_HEADER_BG }}>
                      <td
                        colSpan={pinnedColCount}
                        className="py-1.5 pl-2 pr-1"
                        style={{
                          border: GRID_BORDER,
                          borderRight: "none",
                          borderLeft: GRID_BORDER,
                          position: "sticky",
                          left: 0,
                          zIndex: 31,
                          background: GROUP_HEADER_BG,
                          boxSizing: "border-box",
                          overflow: "hidden",
                          width: pinnedTotalWidth,
                          minWidth: pinnedTotalWidth,
                          maxWidth: pinnedTotalWidth,
                          ...(pinnedColCount > 0
                            ? {
                                boxShadow: `-12px 0 0 0 ${GROUP_HEADER_BG}, 2px 0 6px rgba(0,0,0,0.08)`,
                              }
                            : {}),
                        }}
                      >
                        <span
                          className="flex items-center gap-1 text-[11px] font-bold min-w-0"
                          style={{
                            color: "#0c4a6e",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={`${filename} (${groupVesselCount} vessel${groupVesselCount !== 1 ? "s" : ""})`}
                        >
                          {groupHeaderIcon ? <span>{groupHeaderIcon}</span> : null}
                          <span>{filename}</span>
                          <span className="font-normal" style={{ color: "#64748b" }}>
                            ({groupVesselCount} vessel{groupVesselCount !== 1 ? "s" : ""})
                          </span>
                        </span>
                      </td>
                      {scrollColCount > 0 ? (
                        <td
                          colSpan={scrollColCount}
                          className="py-1.5"
                          style={{
                            border: GRID_BORDER,
                            borderLeft: "none",
                            background: GROUP_HEADER_BG,
                          }}
                        />
                      ) : null}
                    </tr>
                  )}
                  <tr
                    style={{ background: rowBg }}
                    onMouseEnter={() => setHoveredRowId(row.id)}
                    onMouseLeave={() => setHoveredRowId(null)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        style={tdStyle(cell.column.id, rowBg, row.id)}
                        className={`align-top ${
                          cell.column.id === "_select" ? "text-center px-1" : ""
                        }`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
