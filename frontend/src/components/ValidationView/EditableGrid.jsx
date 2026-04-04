import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import { Fragment, useState } from "react";

const helper = createColumnHelper();

function EditableCell({ getValue, row, column, table }) {
  const initial = getValue() ?? "";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);

  const commit = () => {
    setEditing(false);
    if (value !== initial) {
      table.options.meta?.onCellEdit(row.original.id, column.id, value);
    }
  };

  if (!editing) {
    return (
      <div
        onDoubleClick={() => setEditing(true)}
        className="px-2 py-1 cursor-text min-h-[22px] text-xs whitespace-nowrap overflow-hidden text-ellipsis max-w-[200px]"
        style={{ color: value ? "#0c4a6e" : "#bae6fd", fontStyle: value ? "normal" : "italic" }}
        title={value || "double-click to edit"}
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
      className="w-full min-w-[80px] px-2 py-0.5 bg-sky-50 border border-sky-400 rounded text-xs text-sky-800 outline-none"
    />
  );
}

function EditableRegionCell({ getValue, row, column, table }) {
  const initial = getValue() ?? "";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);

  const commit = () => {
    setEditing(false);
    if (value !== initial) {
      table.options.meta?.onCellEdit(row.original.id, "__region__", value);
    }
  };

  if (!editing) {
    return (
      <div
        onDoubleClick={() => setEditing(true)}
        className="px-2 py-1 cursor-text text-xs font-bold whitespace-nowrap"
        style={{ color: "#0369a1" }}
        title="double-click to edit"
      >
        {value || <span style={{ color: "#bae6fd", fontWeight: "normal", fontStyle: "italic" }}>—</span>}
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
      className="w-full min-w-[120px] px-2 py-0.5 bg-sky-50 border border-sky-400 rounded text-xs text-sky-800 outline-none uppercase font-semibold"
    />
  );
}

export default function EditableGrid({ data, columns: colKeys, onCellEdit, onDeleteRow, deleteMode, selectedIds, onToggleSelect, onToggleAll }) {
  const allSelected = data.length > 0 && data.every((v) => selectedIds.has(v.id));
  const someSelected = data.some((v) => selectedIds.has(v.id));

  const deletCol = helper.display({
    id: "_delete",
    header: "",
    size: 36,
    cell: (info) => (
      <button
        onClick={() => onDeleteRow(info.row.original.id)}
        className="px-2 text-red-400 hover:text-red-600 transition-colors text-sm"
        title="Delete row"
      >
        ✕
      </button>
    ),
  });

  const columnDefs = [
    helper.display({
      id: "_select",
      size: 36,
      header: () => (
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
          onChange={() => onToggleAll()}
          className="cursor-pointer accent-sky-500"
          title={allSelected ? "Deselect all" : "Select all"}
        />
      ),
      cell: (info) => (
        <input
          type="checkbox"
          checked={selectedIds.has(info.row.original.id)}
          onChange={() => onToggleSelect(info.row.original.id)}
          className="cursor-pointer accent-sky-500"
        />
      ),
    }),
    helper.display({
      id: "_num",
      header: "#",
      size: 40,
      cell: (info) => (
        <span className="text-xs px-2" style={{ color: "#7dd3fc" }}>{info.row.index + 1}</span>
      ),
    }),
    ...(deleteMode ? [deletCol] : []),
    helper.accessor("region", {
      id: "region",
      header: "REGION",
      size: 160,
      cell: EditableRegionCell,
    }),
    ...colKeys
      .filter((k) => k !== "region")
      .map((key) =>
        helper.accessor((row) => row.dynamic_data?.[key] ?? "", {
          id: key,
          header: key.replace(/_/g, " ").toUpperCase(),
          size: 130,
          cell: EditableCell,
        })
      ),
  ];

  const table = useReactTable({
    data,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    meta: { onCellEdit },
  });

  if (data.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm italic" style={{ color: "#7dd3fc" }}>
        No vessels loaded. Select an email from the Inbox first.
      </div>
    );
  }

  const rows = table.getRowModel().rows;
  const colCount = table.getVisibleLeafColumns().length;

  return (
    <div className="overflow-auto flex-1 rounded-xl shadow-md" style={{ border: "1px solid #bae6fd" }}>
      <table className="min-w-max text-xs" style={{ borderCollapse: "collapse" }}>
        <thead className="sticky top-0 z-20">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} style={{ background: "#0369a1" }}>
              {hg.headers.map((header) => (
                <th
                  key={header.id}
                  style={{
                    width: header.column.columnDef.size,
                    color: "#e0f2fe",
                    borderBottom: "2px solid #0284c7",
                    borderRight: "1px solid #0284c7",
                    fontWeight: 600,
                  }}
                  className={`px-2 py-2.5 text-xs whitespace-nowrap select-none ${
                    header.id === "_select" ? "text-center" : "text-left"
                  }`}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const currentAttId = row.original.attachment_id;
            const prevAttId = i > 0 ? rows[i - 1].original.attachment_id : null;
            const isNewGroup = currentAttId !== prevAttId;
            const filename = (row.original.filename || currentAttId || "Unknown Source")
              .replace(/\.eml$/i, "");

            return (
              <Fragment key={row.id}>
                {isNewGroup && (
                  <tr style={{ background: "#e0f2fe", borderTop: "2px solid #7dd3fc", borderBottom: "1px solid #bae6fd" }}>
                    <td colSpan={colCount} className="px-3 py-1.5">
                      <span className="flex items-center gap-1.5 text-xs font-bold" style={{ color: "#0369a1" }}>
                        <span>📎</span>
                        <span>{filename}</span>
                      </span>
                    </td>
                  </tr>
                )}
                <tr
                  style={{ background: i % 2 === 0 ? "#ffffff" : "#f0f9ff", transition: "background 0.1s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#e0f2fe"}
                  onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? "#ffffff" : "#f0f9ff"}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      style={{
                        borderBottom: "1px solid #e0f2fe",
                        borderRight: "1px solid #e0f2fe",
                      }}
                      className={`align-middle ${cell.column.id === "_select" ? "text-center px-2" : ""}`}
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
  );
}
