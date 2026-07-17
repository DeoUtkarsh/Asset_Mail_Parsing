/**
 * Vessel grid columns — definitions loaded from GET /api/columns (PostgreSQL).
 * Fallback defaults used until the API responds.
 */

export const DEFAULT_COLUMNS = [
  { id: "_num", header: "SR. NO", display_order: 0, read_only: true, storage: "derived" },
  { id: "imo", header: "IMO", display_order: 1, read_only: false, storage: "dynamic_data" },
  { id: "company", header: "COMPANY", display_order: 2, read_only: false, storage: "dynamic_data" },
  { id: "vessel_name", header: "VESSEL NAME", display_order: 3, read_only: false, storage: "dynamic_data" },
  { id: "call_sign", header: "CALL SIGN", display_order: 4, read_only: false, storage: "dynamic_data" },
  { id: "year_built", header: "YEAR BUILT", display_order: 5, read_only: false, storage: "dynamic_data" },
  { id: "vessel_type", header: "VESSEL TYPE", display_order: 6, read_only: false, storage: "dynamic_data" },
  { id: "cargo_type", header: "CARGO TYPE", display_order: 7, read_only: false, storage: "dynamic_data" },
  { id: "direction", header: "DIRECTION", display_order: 8, read_only: false, storage: "dynamic_data" },
  { id: "dwt_sdwt", header: "DWT/SDWT", display_order: 9, read_only: false, storage: "dynamic_data" },
  { id: "cbm", header: "CBM/CUBIC METER", display_order: 10, read_only: false, storage: "dynamic_data" },
  { id: "draft", header: "DRAFT", display_order: 11, read_only: false, storage: "dynamic_data" },
  { id: "flag", header: "FLAG", display_order: 12, read_only: false, storage: "dynamic_data" },
  { id: "eta_foc", header: "ETA FOC", display_order: 13, read_only: false, storage: "dynamic_data" },
  { id: "region", header: "REGION", display_order: 14, read_only: false, storage: "region" },
  { id: "open_location", header: "OPEN LOCATION", display_order: 15, read_only: false, storage: "dynamic_data" },
  { id: "opening_date", header: "OPENING DATE", display_order: 16, read_only: false, storage: "dynamic_data" },
  { id: "cargo_history_combo", header: "CARGO HISTORY/L3C/LAST 3 CARGOES", display_order: 17, read_only: false, storage: "dynamic_data" },
  { id: "tank_coating", header: "TANK COATING", display_order: 18, read_only: false, storage: "dynamic_data" },
  { id: "sire_date", header: "SIRE DATE", display_order: 19, read_only: false, storage: "dynamic_data" },
  { id: "sire_location", header: "SIRE LOCATION", display_order: 20, read_only: false, storage: "dynamic_data" },
  { id: "cdi_date", header: "CDI DATE", display_order: 21, read_only: false, storage: "dynamic_data" },
  { id: "cdi_location", header: "CDI LOCATION", display_order: 22, read_only: false, storage: "dynamic_data" },
  { id: "remarks", header: "REMARKS", display_order: 23, read_only: false, storage: "dynamic_data" },
  { id: "other_info", header: "OTHER INFO", display_order: 24, read_only: true, storage: "dynamic_data" },
  { id: "q88", header: "Q88 AVAILABLE", display_order: 25, read_only: false, storage: "dynamic_data" },
  { id: "attachments", header: "ATTACHMENTS", display_order: 26, read_only: true, storage: "derived" },
  { id: "status", header: "STATUS", display_order: 27, read_only: false, storage: "dynamic_data" },
];

export const COLUMN_WIDTHS = {
  _num: 58,
  received: 150,
  imo: 90,
  company: 200,
  vessel_name: 180,
  call_sign: 90,
  year_built: 90,
  vessel_type: 110,
  cargo_type: 120,
  direction: 110,
  dwt_sdwt: 100,
  cbm: 110,
  draft: 80,
  flag: 80,
  eta_foc: 120,
  region: 110,
  open_location: 120,
  opening_date: 110,
  cargo_history_combo: 200,
  tank_coating: 110,
  sire_date: 100,
  sire_location: 110,
  cdi_date: 100,
  cdi_location: 110,
  remarks: 160,
  other_info: 100,
  q88: 100,
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

/** Always visible in compact mode (_num, vessel name, IMO). */
export const COMPACT_ALWAYS_VISIBLE_COLUMN_IDS = new Set(["_num", "vessel_name", "imo", "company"]);

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
  "imo",
  "company",
  "vessel_name",
  "region",
  "dwt_sdwt",
  "year_built",
  "tank_coating",
  "open_location",
  "opening_date",
  "direction",
  "cargo_history_combo",
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
export const DRAFT_LOCKED_COLUMN_IDS = new Set(["vessel_name", "region", "imo"]);

/** Grid-only columns — not sent to draft API. */
export const DRAFT_NON_SELECTABLE_COLUMN_IDS = new Set(["_num", "received", "attachments"]);

export function defaultDraftSelectedColumnIds(columnDefs = DEFAULT_COLUMNS) {
  const allowed = new Set(columnDefs.map((c) => c.id));
  return new Set(
    POSITION_LIST_SUMMARY_COLUMN_ORDER.filter(
      (id) => allowed.has(id) && !DRAFT_NON_SELECTABLE_COLUMN_IDS.has(id),
    ),
  );
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

/** Read cell value directly from DB-shaped vessel row. */
export function resolveStandardCellValue(vessel, columnId, rowNum = 1) {
  if (columnId === "_num") return String(rowNum);
  if (columnId === "received") return formatReceived(vessel?.date_received);
  if (columnId === "region") return vessel?.region ?? "";
  if (columnId === "attachments") {
    return (vessel?.filename || "").replace(/\.eml$/i, "") || "";
  }
  return vessel?.dynamic_data?.[columnId] ?? "";
}

export const EMAIL_TABLE_COLUMNS = DEFAULT_COLUMNS.filter((c) => c.id !== "_num");

export function enrichColumnDefs(defs) {
  return (defs || DEFAULT_COLUMNS).map((c) => ({
    ...c,
    width: COLUMN_WIDTHS[c.id] ?? 100,
    vesselName: c.id === "vessel_name",
    region: c.storage === "region",
  }));
}
