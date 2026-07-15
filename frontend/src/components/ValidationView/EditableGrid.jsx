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

const GRID_BORDER = "1px solid var(--line)";

/** Checkbox (if shown), SR. NO, IMO, VESSEL NAME, REGION stay fixed when scrolling. */
function buildPinnedOrder(showCheckboxes) {
  const cols = ["_num", "imo", "company", "vessel_name", "region"];
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
        onDoubleClick={
          readOnly || !editField ? undefined : () => setEditing(true)
        }
        className={`cell-val ${value ? "" : "is-empty"} ${
          readOnly || !editField ? "cursor-default" : "cursor-text"
        } ${vesselName ? "font-bold uppercase" : ""}`}
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
        onDoubleClick={readOnly ? undefined : () => setEditing(true)}
        className={`cell-val font-bold uppercase ${value ? "" : "is-empty"} ${
          readOnly ? "cursor-default" : "cursor-text"
        }`}
        style={value ? { color: "var(--brand-d)" } : undefined}
        title={readOnly ? initial || "" : "Double-click to edit · Enter to save"}
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
        if (e.key === "Enter") commit();
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

export default function EditableGrid({
  data,
  columns: _legacyColumns,
  gridColumns,
  onCellEdit,
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
}) {
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

    if (!showColumnSelect || !isDraftColumnSelectable(colId)) {
      return label;
    }

    const checked = selectedColumnIds.has(colId);

    return (
      <div className="col-hdr">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggleColumnSelect?.(colId)}
          title="Include in draft email"
        />
        <span title={label}>{label}</span>
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
    if (
      showColumnSelect
      && isDraftColumnSelectable(columnId)
      && selectedColumnIds.has(columnId)
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
    return "";
  };

  const thStyle = (columnId) => {
    const w = effectiveColWidth(columnId);
    const pinned = pinnedLeftById[columnId];
    const isDraftOn =
      showColumnSelect
      && isDraftColumnSelectable(columnId)
      && selectedColumnIds.has(columnId);
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

  const tdStyle = (columnId) => {
    const w = effectiveColWidth(columnId);
    const pinned = pinnedLeftById[columnId];
    return {
      width: w,
      minWidth: w,
      maxWidth: w,
      ...(pinned != null
        ? {
            position: "sticky",
            left: pinned,
            zIndex: columnId === "_select" ? 26 : 25,
            ...(columnId === firstPinnedId ? { borderLeft: GRID_BORDER } : {}),
            ...pinnedShadows(columnId, "#fff"),
          }
        : {}),
    };
  };

  return (
    <div className="vessel-grid-wrap">
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
            {rows.map((row, i) => {
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
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        style={tdStyle(cell.column.id)}
                        className={bodyCellClass(cell.column.id)}
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
