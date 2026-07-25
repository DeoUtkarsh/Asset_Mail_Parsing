/**
 * Vessel grid columns — definitions loaded from GET /api/columns (PostgreSQL).
 * Fallback defaults used until the API responds.
 */

import { formatStandardField } from "./fieldFormat";

export const DEFAULT_COLUMNS = [
  { id: "_num", header: "SR. NO", display_order: 0, read_only: true, storage: "derived" },
  { id: "vessel_name", header: "VESSEL NAME", display_order: 1, read_only: false, storage: "dynamic_data" },
  { id: "dwt_sdwt", header: "DWT/SDWT", display_order: 2, read_only: false, storage: "dynamic_data" },
  { id: "year_built", header: "YEAR BUILT", display_order: 3, read_only: false, storage: "dynamic_data" },
  { id: "tank_coating", header: "TANK COATING", display_order: 4, read_only: false, storage: "dynamic_data" },
  { id: "imo", header: "IMO", display_order: 5, read_only: false, storage: "dynamic_data" },
  { id: "imo_type", header: "IMO TYPE", display_order: 6, read_only: false, storage: "dynamic_data" },
  { id: "region", header: "REGION", display_order: 7, read_only: false, storage: "region" },
  { id: "opening_date", header: "OPENING DATE", display_order: 8, read_only: false, storage: "dynamic_data" },
  { id: "open_location", header: "OPEN LOCATION", display_order: 9, read_only: false, storage: "dynamic_data" },
  { id: "direction", header: "DIRECTION", display_order: 10, read_only: false, storage: "dynamic_data" },
  { id: "cbm", header: "CBM/CUBIC METER", display_order: 11, read_only: false, storage: "dynamic_data" },
  { id: "cargo_history_combo", header: "LAST 3 CARGOES", display_order: 12, read_only: false, storage: "dynamic_data" },
  { id: "company", header: "COMPANY", display_order: 13, read_only: false, storage: "dynamic_data" },
  { id: "call_sign", header: "CALL SIGN", display_order: 14, read_only: false, storage: "dynamic_data" },
  { id: "vessel_type", header: "VESSEL TYPE", display_order: 15, read_only: false, storage: "dynamic_data" },
  { id: "cargo_type", header: "CARGO TYPE", display_order: 16, read_only: false, storage: "dynamic_data" },
  { id: "draft", header: "DRAFT", display_order: 17, read_only: false, storage: "dynamic_data" },
  { id: "flag", header: "FLAG", display_order: 18, read_only: false, storage: "dynamic_data" },
  { id: "eta_foc", header: "ETA FOC", display_order: 19, read_only: false, storage: "dynamic_data" },
  { id: "sire_date", header: "SIRE DATE", display_order: 20, read_only: false, storage: "dynamic_data" },
  { id: "sire_location", header: "SIRE LOCATION", display_order: 21, read_only: false, storage: "dynamic_data" },
  { id: "cdi_date", header: "CDI DATE", display_order: 22, read_only: false, storage: "dynamic_data" },
  { id: "cdi_location", header: "CDI LOCATION", display_order: 23, read_only: false, storage: "dynamic_data" },
  { id: "remarks", header: "REMARKS", display_order: 24, read_only: false, storage: "dynamic_data" },
  { id: "other_info", header: "EXTRA INFO", display_order: 25, read_only: true, storage: "dynamic_data" },
  { id: "q88", header: "Q88 AVAILABLE", display_order: 26, read_only: false, storage: "dynamic_data" },
  { id: "attachments", header: "ATTACHMENTS", display_order: 27, read_only: true, storage: "derived" },
  { id: "status", header: "STATUS", display_order: 28, read_only: false, storage: "dynamic_data" },
];

export const COLUMN_WIDTHS = {
  _num: 58,
  received: 150,
  imo: 90,
  imo_type: 100,
  company: 200,
  vessel_name: 180,
  call_sign: 110,
  year_built: 110,
  vessel_type: 120,
  cargo_type: 120,
  direction: 110,
  dwt_sdwt: 112,
  cbm: 160,
  draft: 80,
  flag: 80,
  eta_foc: 120,
  region: 160,
  open_location: 150,
  opening_date: 140,
  cargo_history_combo: 260,
  tank_coating: 140,
  sire_date: 110,
  sire_location: 130,
  cdi_date: 110,
  cdi_location: 130,
  remarks: 160,
  other_info: 140,
  q88: 130,
  attachments: 180,
  status: 100,
};

/** @deprecated use column defs from API */
export const STANDARD_COLUMNS = DEFAULT_COLUMNS.map((c) => ({
  ...c,
  width: COLUMN_WIDTHS[c.id] ?? 100,
  vesselName: c.id === "vessel_name",
  region: c.storage === "region",
}));

export const STANDARD_COLUMN_IDS = DEFAULT_COLUMNS.map((c) => c.id);

export function hasDisplayValue(val) {
  if (val == null) return false;
  const s = String(val).trim();
  if (!s) return false;
  const empty = new Set(["", "-", "—", "n/a", "na", "unknown", "tba"]);
  if (empty.has(s.toLowerCase())) return false;
  return true;
}

/** Always visible in compact mode. */
export const COMPACT_ALWAYS_VISIBLE_COLUMN_IDS = new Set([
  "_num",
  "vessel_name",
  "imo",
  "imo_type",
  "company",
]);

/** @deprecated use COMPACT_ALWAYS_VISIBLE_COLUMN_IDS */
export const PREVIEW_ALWAYS_VISIBLE_COLUMN_IDS = COMPACT_ALWAYS_VISIBLE_COLUMN_IDS;

const PREVIEW_COMPACT_STORAGE_KEY = "emailPreviewCompactColumns";
const PREVIEW_ALL_COLUMNS_KEY = "emailPreviewShowAllColumns";

export function readPreviewCompactColumnsPref() {
  return readCompactColumnsPref(PREVIEW_COMPACT_STORAGE_KEY);
}

export function writePreviewCompactColumnsPref(compact) {
  writeCompactColumnsPref(PREVIEW_COMPACT_STORAGE_KEY, compact);
}

export function readPreviewShowAllColumnsPref() {
  try {
    const stored = sessionStorage.getItem(PREVIEW_ALL_COLUMNS_KEY);
    if (stored === null) return false;
    return stored === "true";
  } catch {
    return false;
  }
}

export function writePreviewShowAllColumnsPref(showAll) {
  try {
    sessionStorage.setItem(PREVIEW_ALL_COLUMNS_KEY, showAll ? "true" : "false");
  } catch {
    /* ignore */
  }
}

function readCompactColumnsPref(key) {
  try {
    const stored = sessionStorage.getItem(key);
    if (stored === null) return true;
    return stored === "true";
  } catch {
    return true;
  }
}

function writeCompactColumnsPref(key, compact) {
  try {
    sessionStorage.setItem(key, compact ? "true" : "false");
  } catch {
    /* ignore */
  }
}

/**
 * Compact grid: hide columns empty on every vessel row.
 * A column stays if any row has a display value (— / blank / n/a = empty).
 */
export function filterCompactGridColumns(
  vessels,
  columnDefs,
  compact,
  alwaysVisible = COMPACT_ALWAYS_VISIBLE_COLUMN_IDS,
) {
  const defs = columnDefs?.length ? columnDefs : DEFAULT_COLUMNS;
  if (!compact || !vessels?.length) return defs;
  return defs.filter((col) => {
    if (alwaysVisible.has(col.id)) return true;
    return vessels.some((v, i) =>
      hasDisplayValue(resolveStandardCellValue(v, col.id, i + 1)),
    );
  });
}

/** @deprecated use filterCompactGridColumns */
export function filterPreviewGridColumns(vessels, columnDefs, compact) {
  return filterCompactGridColumns(vessels, columnDefs, compact);
}

/** Vessel Position List default view — fixed summary columns (broker position list layout). */
export const POSITION_LIST_SUMMARY_COLUMN_ORDER = [
  "_num",
  "vessel_name",
  "dwt_sdwt",
  "year_built",
  "tank_coating",
  "imo",
  "imo_type",
  "region",
  "opening_date",
  "open_location",
  "direction",
  "cbm",
  "cargo_history_combo",
  "company",
];

export const POSITION_LIST_SUMMARY_COLUMN_IDS = new Set(POSITION_LIST_SUMMARY_COLUMN_ORDER);

const POSITION_LIST_ALL_COLUMNS_KEY = "vesselPositionListShowAllColumns";

export function readPositionListShowAllColumnsPref() {
  try {
    const stored = sessionStorage.getItem(POSITION_LIST_ALL_COLUMNS_KEY);
    if (stored === null) return false;
    return stored === "true";
  } catch {
    return false;
  }
}

export function writePositionListShowAllColumnsPref(showAll) {
  try {
    sessionStorage.setItem(POSITION_LIST_ALL_COLUMNS_KEY, showAll ? "true" : "false");
  } catch {
    /* ignore */
  }
}

export function filterPositionListGridColumns(columnDefs, showAllColumns) {
  const defs = columnDefs?.length ? columnDefs : DEFAULT_COLUMNS;
  const byId = new Map(defs.map((c) => [c.id, c]));
  const summary = POSITION_LIST_SUMMARY_COLUMN_ORDER.map((id) => byId.get(id)).filter(Boolean);
  if (!showAllColumns) return summary;
  const summaryIdSet = POSITION_LIST_SUMMARY_COLUMN_IDS;
  const rest = defs.filter((col) => !summaryIdSet.has(col.id));
  return [...summary, ...rest];
}

/** Always included in draft email tables (no checkbox in grid). */
export const DRAFT_LOCKED_COLUMN_IDS = new Set(["vessel_name", "region", "imo", "imo_type"]);

/** Grid-only columns — not sent to draft API. "company" is confidential and must
 *  never appear in an outgoing position-list email. */
export const DRAFT_NON_SELECTABLE_COLUMN_IDS = new Set(["_num", "received", "attachments", "company"]);

export function defaultDraftSelectedColumnIds(columnDefs = DEFAULT_COLUMNS) {
  const allowed = new Set((columnDefs?.length ? columnDefs : DEFAULT_COLUMNS).map((c) => c.id));
  // Every default Position List column that belongs in Generate Draft — always on at open.
  const ids = POSITION_LIST_SUMMARY_COLUMN_ORDER.filter(
    (id) => allowed.has(id) && !DRAFT_NON_SELECTABLE_COLUMN_IDS.has(id),
  );
  DRAFT_LOCKED_COLUMN_IDS.forEach((id) => {
    if (allowed.has(id) && !ids.includes(id)) ids.push(id);
  });
  return new Set(ids);
}

export function isDraftColumnSelectable(columnId) {
  if (columnId === "_select") return false;
  if (DRAFT_NON_SELECTABLE_COLUMN_IDS.has(columnId)) return false;
  if (DRAFT_LOCKED_COLUMN_IDS.has(columnId)) return false;
  return true;
}

/** Ordered column ids for draft API from user selection + locked columns. */
export function buildDraftColumnIdList(selectedIds, columnDefs = DEFAULT_COLUMNS) {
  const defs = columnDefs?.length ? columnDefs : DEFAULT_COLUMNS;
  const merged = new Set([...selectedIds, ...DRAFT_LOCKED_COLUMN_IDS]);
  return defs
    .filter((c) => merged.has(c.id) && !DRAFT_NON_SELECTABLE_COLUMN_IDS.has(c.id))
    .map((c) => c.id);
}

export function headerForStandardColumn(id, columnDefs = DEFAULT_COLUMNS) {
  const col = columnDefs.find((c) => c.id === id);
  return col?.header ?? id.replace(/_/g, " ").toUpperCase();
}

export function editFieldForColumn(colDefOrId, columnDefs = DEFAULT_COLUMNS) {
  const col = typeof colDefOrId === "string"
    ? columnDefs.find((c) => c.id === colDefOrId)
    : colDefOrId;
  if (!col || col.read_only) return null;
  if (col.storage === "region") return "__region__";
  if (col.storage === "dynamic_data") return col.id;
  return null;
}

export function isVesselNameColumn(id) {
  return id === "vessel_name";
}

export function isRegionColumn(id) {
  return id === "region";
}

/** Format an email received timestamp as "17 Jul 2026, 09:42" (24h). */
export function formatReceived(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date}, ${time}`;
}

/** Comma-separated names of real file attachments on the source email. */
export function formatAttachmentFiles(files) {
  if (!files?.length) return "";
  return files
    .map((f) => (f?.name || "").trim())
    .filter(Boolean)
    .join(", ");
}

/** True when a value is an IMO type code (2, 2/3, IMO II), not a 7-digit IMO number. */
export function looksLikeImoType(val) {
  if (val == null) return false;
  const s = String(val).trim();
  if (!s) return false;
  if (/^\d{7}$/.test(s)) return false;
  const norm = s.replace(/\s+/g, "").toLowerCase();
  if (/^imo[\d/]/i.test(norm)) return true;
  if (/^\d+(\/\d+)?$/.test(norm)) return true;
  if (/^(i{1,3}|ii|iii|iv)(\/(i{1,3}|ii|iii|iv))?$/.test(norm)) return true;
  return false;
}

/** Strip parenthetical notes: 'Hub zone (open-position term)' → 'Hub zone'. */
export function stripParentheticalExtras(text) {
  let s = String(text || "").trim();
  if (!s) return "";
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(/\s*\([^)]*\)/g, "").trim();
    s = s.replace(/\s*\[[^\]]*\]/g, "").trim();
  }
  return s.replace(/\s{2,}/g, " ").trim();
}

/** Read cell value directly from DB-shaped vessel row. */
export function resolveStandardCellValue(vessel, columnId, rowNum = 1) {
  if (columnId === "_num") return String(rowNum);
  if (columnId === "received") return formatReceived(vessel?.date_received);
  if (columnId === "region") {
    return stripParentheticalExtras(vessel?.region ?? "");
  }
  if (columnId === "attachments") {
    return formatAttachmentFiles(vessel?.attachment_files);
  }
  const dd = vessel?.dynamic_data || {};
  if (columnId === "open_location") {
    return stripParentheticalExtras(dd.open_location ?? "");
  }
  if (columnId === "vessel_type") {
    const vt = dd.vessel_type ?? "";
    const imo = dd.imo ?? "";
    const imoType = dd.imo_type ?? "";
    if (looksLikeImoType(vt) || (vt && imo && String(vt).trim() === String(imo).trim())) {
      return "";
    }
    if (vt && imoType && String(vt).trim() === String(imoType).trim()) {
      return "";
    }
    return vt;
  }
  if (columnId === "imo") {
    const imo = dd.imo ?? "";
    if (imo && !looksLikeImoType(imo)) return imo;
    return "";
  }
  if (columnId === "imo_type") {
    const imoType = dd.imo_type ?? "";
    if (imoType) return imoType;
    if (looksLikeImoType(dd.imo)) return dd.imo;
    if (looksLikeImoType(dd.vessel_type)) return dd.vessel_type;
    return "";
  }
  const raw = dd[columnId] ?? "";
  if (columnId === "ai_normalized") return "";
  return formatStandardField(columnId, raw);
}

export const EMAIL_TABLE_COLUMNS = DEFAULT_COLUMNS.filter((c) => c.id !== "_num");

/** Sort vessels grouped by source email, then in-mail order (row_order). */
export function sortVesselsBySourceOrder(vessels) {
  const list = [...(vessels || [])];
  const groupDate = new Map();
  for (const v of list) {
    const aid = v.attachment_id || "_none";
    const t = v.date_received ? new Date(v.date_received).getTime() : 0;
    const prev = groupDate.get(aid);
    if (prev == null || t > prev) groupDate.set(aid, t);
  }
  return list.sort((a, b) => {
    const aidA = a.attachment_id || "_none";
    const aidB = b.attachment_id || "_none";
    if (aidA !== aidB) {
      const da = groupDate.get(aidA) || 0;
      const db = groupDate.get(aidB) || 0;
      if (da !== db) return db - da; // newer emails first
      return String(aidA).localeCompare(String(aidB));
    }
    const ao = a?.row_order ?? 0;
    const bo = b?.row_order ?? 0;
    if (ao !== bo) return ao - bo;
    const at = a?.created_at ? new Date(a.created_at).getTime() : 0;
    const bt = b?.created_at ? new Date(b.created_at).getTime() : 0;
    return at - bt;
  });
}

/** Minimum px width so a grid header label shows in full (no … truncation). */
export function minColumnWidthForHeader(header, floor = 48) {
  const text = String(header ?? "").trim();
  if (!text) return floor;
  // Poppins bold uppercase ≈ 8px/char at ~12px; + draft checkbox + padding.
  const charW = 8.2;
  const checkboxPad = 22;
  return Math.max(floor, Math.ceil(text.length * charW) + 28 + checkboxPad);
}

/** Grid columns that stay single-line with ellipsis (short numbers/codes only). */
export const SINGLE_LINE_COLUMN_IDS = new Set([
  "_num",
  "received",
  "imo",
  "call_sign",
  "year_built",
  "dwt_sdwt",
  "cbm",
  "draft",
]);

export function enrichColumnDefs(defs) {
  return (defs || DEFAULT_COLUMNS).map((c) => {
    const base = COLUMN_WIDTHS[c.id] ?? 100;
    return {
      ...c,
      width: Math.max(base, minColumnWidthForHeader(c.header, base)),
      vesselName: c.id === "vessel_name",
      region: c.storage === "region",
    };
  });
}
