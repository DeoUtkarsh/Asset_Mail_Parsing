import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import { Fragment, useMemo, useState } from "react";
import {
  STANDARD_COLUMNS,
  resolveStandardCellValue,
  editFieldForColumn,
  isVesselNameColumn,
  isRegionColumn,
} from "../../utils/standardColumns";

const helper = createColumnHelper();

const GRID_BORDER = "1px solid #94a3b8";

/** Checkbox (if shown), SR. NO, IMO, VESSEL NAME stay fixed when scrolling. */
function buildPinnedOrder(showCheckboxes) {
  const cols = ["_num", "imo", "vessel_name"];
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

function EditableCell({ getValue, row, column, table, vesselName = false }) {
  const initial = getValue() ?? "";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);
  const readOnly = table.options.meta?.readOnly;

  const commit = () => {
    setEditing(false);
    if (value !== initial) {
      const field = editFieldForColumn(column.id);
      if (field) table.options.meta?.onCellEdit(row.original.id, field, value);
    }
  };

  if (!editing || readOnly) {
    return (
      <div
        onDoubleClick={
          readOnly || !editFieldForColumn(column.id) ? undefined : () => setEditing(true)
        }
        className={`px-1.5 py-0.5 min-h-[20px] text-[11px] leading-snug whitespace-normal break-words w-full ${
          vesselName ? "font-bold" : ""
        } ${readOnly || !editFieldForColumn(column.id) ? "cursor-default" : "cursor-text"}`}
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
  onCellEdit,
  readOnly = false,
  showCheckboxes = false,
  hideGroupHeaders = false,
  groupHeaderIcon = "📎",
  selectedIds = new Set(),
  onToggleSelect,
  onToggleAll,
}) {
  const [hoveredRowId, setHoveredRowId] = useState(null);

  const groupCounts = useMemo(() => {
    const counts = new Map();
    data.forEach((v) => {
      const id = v.attachment_id;
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    return counts;
  }, [data]);

  const allSelected = showCheckboxes && data.length > 0 && data.every((v) => selectedIds.has(v.id));
  const someSelected = showCheckboxes && data.some((v) => selectedIds.has(v.id));

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

    for (const col of STANDARD_COLUMNS) {
      const isReadOnly = col.readOnly || col.id === "_num";
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
                />
              );
            }
            return <EditableCell {...info} getValue={() => value} />;
          },
        })
      );
    }

    return cols;
  }, [
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
    meta: { onCellEdit, readOnly },
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
      <div className="flex-1 flex items-center justify-center text-sm italic" style={{ color: "#7dd3fc" }}>
        No vessels loaded. Fetch emails on Email Data first.
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
  const pinnedTotalWidth = pinnedLeafColumns.reduce(
    (sum, col) => sum + (col.columnDef.size || 100),
    0
  );
  const GROUP_HEADER_BG = "#dbeafe";

  const totalTableWidth = leafColumns.reduce(
    (sum, col) => sum + (col.columnDef.size || 100),
    0
  );

  const colWidth = (columnId) =>
    leafColumns.find((c) => c.id === columnId)?.columnDef.size || 100;

  /** Extends sticky cell paint to the left edge so scrolled content cannot peek through. */
  const pinnedShadows = (columnId, bg) => {
    const parts = [];
    if (columnId === firstPinnedId) parts.push(`-12px 0 0 0 ${bg}`);
    if (columnId === lastPinnedId) parts.push("2px 0 6px rgba(0,0,0,0.08)");
    return parts.length ? { boxShadow: parts.join(", ") } : {};
  };

  const thStyle = (columnId) => {
    const w = colWidth(columnId);
    const pinned = pinnedLeftById[columnId];
    const bg = headerStyle.background;
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
    const w = colWidth(columnId);
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
      <div className="overflow-auto flex-1 min-h-0 overscroll-contain bg-white">
        <table
          className="text-[11px] leading-tight bg-white"
          style={{
            ...tableStyle,
            tableLayout: "fixed",
            width: totalTableWidth,
            minWidth: totalTableWidth,
          }}
        >
          <colgroup>
            {leafColumns.map((col) => (
              <col key={col.id} style={{ width: col.columnDef.size || 100 }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  style={thStyle(header.column.id)}
                  className={`py-1.5 text-[11px] whitespace-nowrap select-none ${
                    header.id === "_select" ? "text-center px-1.5" : header.id === "_num" ? "text-left pr-1.5" : "text-left px-1.5"
                  }`}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
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
