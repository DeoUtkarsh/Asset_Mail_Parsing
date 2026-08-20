import { contactCellValue, buildContactSerialMap } from "./contactColumns";

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Format one cell the same way the Contact List grid displays it. */
export function contactCellForExport(row, col, formatDate, serialNo) {
  const key = typeof col === "string" ? col : col.key;
  const formatted = contactCellValue(row, key, { formatDate, serialNo });
  if (key === "date_received" && formatted === "—") return "";
  return String(formatted ?? "").trim();
}

/**
 * Download contact rows as CSV — headers and column order match the UI table.
 * @param {object[]} rows
 * @param {{ key: string, label: string }[]} columns
 * @param {(iso: string) => string} formatDate
 * @param {(rows: object[]) => Map<string, number>} [serialMapBuilder]
 */
export function downloadContactsCsv(rows, columns, formatDate, serialMapBuilder) {
  if (!rows?.length || !columns?.length) return;

  const serialMap = serialMapBuilder?.(rows) ?? new Map();

  const headerLine = columns.map((c) => csvEscape(c.label)).join(",");
  const bodyLines = rows.map((row) => {
    const serialNo = serialMap.get(row.contact_id);
    return columns
      .map((col) => csvEscape(contactCellForExport(row, col, formatDate, serialNo)))
      .join(",");
  });

  const csv = [headerLine, ...bodyLines].join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const link = document.createElement("a");
  link.href = url;
  link.download = `contact-list-${stamp}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
