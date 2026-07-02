function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Format one cell the same way the Contact List grid displays it. */
export function contactCellForExport(row, key, formatDate) {
  if (key === "date_received") {
    const formatted = formatDate(row.date_received);
    return formatted === "—" ? "" : formatted;
  }
  const raw = row[key];
  if (raw == null) return "";
  return String(raw).trim();
}

/**
 * Download contact rows as CSV — headers and column order match the UI table.
 * @param {object[]} rows
 * @param {{ key: string, label: string }[]} columns — ALL_COLUMNS from ContactListView
 * @param {(iso: string) => string} formatDate
 */
export function downloadContactsCsv(rows, columns, formatDate) {
  if (!rows?.length || !columns?.length) return;

  const headerLine = columns.map((c) => csvEscape(c.label)).join(",");
  const bodyLines = rows.map((row) =>
    columns
      .map((col) => csvEscape(contactCellForExport(row, col.key, formatDate)))
      .join(","),
  );

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
