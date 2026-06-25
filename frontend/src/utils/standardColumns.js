/**
 * Fixed vessel grid columns — shared by Email Data, Vessel Position List, Contact List, and email copy.
 */

const EMPTY_VALUES = new Set([
  "", "-", "—", "–", ".", "..", "n/a", "na", "none", "null", "unknown", "tba", "tbc", "tbd",
]);

export function hasDisplayValue(val) {
  if (val == null) return false;
  const s = String(val).trim();
  if (!s) return false;
  if (EMPTY_VALUES.has(s.toLowerCase())) return false;
  if (/^[-–—.]+$/.test(s)) return false;
  return true;
}

function firstHit(dd, keys) {
  for (const k of keys) {
    const v = dd?.[k];
    if (hasDisplayValue(v)) return String(v).trim();
  }
  return "";
}

const IMO_NUMBER_RE = /^\d{7}$/;

/** Valid IMO numbers are 7 digits (optionally embedded in a short label). */
export function extractImoNumber(dd) {
  for (const k of ["imo_number", "imo"]) {
    const v = String(dd?.[k] ?? "").trim();
    if (IMO_NUMBER_RE.test(v)) return v;
  }
  for (const k of ["imo_number", "imo"]) {
    const v = String(dd?.[k] ?? "").trim();
    const m = v.match(/\b(\d{7})\b/);
    if (m) return m[1];
  }
  return "";
}

/** Values like 2/3 or 3 stored in imo — tank IMO class, not IMO number. */
export function looksLikeImoType(val) {
  if (!hasDisplayValue(val)) return false;
  const s = String(val).trim();
  if (IMO_NUMBER_RE.test(s)) return false;
  const norm = s.toLowerCase().replace(/\s+/g, "");
  if (/^imo[\d/]+/.test(norm)) return true;
  if (/^\d(\/\d)?$/.test(norm)) return true;
  if (/^(i{1,3}|ii|iii|iv)(\/(i{1,3}|ii|iii|iv))?$/.test(norm)) return true;
  return false;
}

function resolveMisplacedImoType(dd) {
  for (const k of ["imo", "imo_number"]) {
    const v = dd?.[k];
    if (looksLikeImoType(v)) return String(v).trim();
  }
  return "";
}

function resolveVesselType(dd) {
  const primary = firstHit(dd, ["vessel_type", "type", "imo_type", "tank_type"]);
  if (primary) return primary;
  return resolveMisplacedImoType(dd);
}

function resolveOpenFields(dd) {
  let openUsed = null;
  let location = "";

  for (const k of ["port_name", "position", "area", "open"]) {
    const v = dd?.[k];
    if (hasDisplayValue(v)) {
      location = String(v).trim();
      if (k === "open") openUsed = "location";
      break;
    }
  }

  let date = "";
  for (const k of ["open_date", "when", "dates", "open"]) {
    if (k === "open" && openUsed === "location") continue;
    const v = dd?.[k];
    if (hasDisplayValue(v)) {
      date = String(v).trim();
      break;
    }
  }

  return { location, date };
}

function resolveDwtSdwt(dd) {
  const dwt = firstHit(dd, ["dwt"]);
  const sdwt = firstHit(dd, ["sdwt", "deadweight"]);
  if (dwt && sdwt) return `${dwt} / ${sdwt}`;
  return dwt || sdwt;
}

function resolveCargoHistory(dd) {
  const parts = [];
  for (const k of [
    "cargo_history",
    "l3c",
    "last_3_cargoes",
    "last_3_cargos",
    "last_3_cgo",
    "last_cargo_s",
  ]) {
    const v = dd?.[k];
    if (hasDisplayValue(v)) parts.push(String(v).trim());
  }
  return parts.join(" / ");
}

/** Column metadata for the grid and email export. */
export const STANDARD_COLUMNS = [
  { id: "_num", header: "SR. NO", readOnly: true, width: 58 },
  { id: "imo", header: "IMO", editField: "imo_number", fallbacks: ["imo"], width: 90 },
  { id: "vessel_name", header: "VESSEL NAME", editField: "vessel_name", fallbacks: ["name"], width: 180, vesselName: true },
  { id: "call_sign", header: "CALL SIGN", editField: "call_sign", width: 90 },
  { id: "year_built", header: "YEAR BUILT", editField: "built", fallbacks: ["yard_built", "when"], width: 90 },
  { id: "vessel_type", header: "VESSEL TYPE", editField: "vessel_type", fallbacks: ["type", "imo_type", "tank_type"], width: 110 },
  { id: "cargo_type", header: "CARGO TYPE", editField: "grade", fallbacks: ["last_cargo", "cargo_preference"], width: 120 },
  { id: "dwt_sdwt", header: "DWT/SDWT", editField: "dwt", width: 100 },
  { id: "cbm", header: "CBM/CUBIC METER", editField: "cbm", fallbacks: ["cubic", "cub", "cargo_tank_capacity", "total_cargo_tank_capacities_m3_98"], width: 110 },
  { id: "draft", header: "DRAFT", editField: "draft", fallbacks: ["sdraft", "sdwt_draft"], width: 80 },
  { id: "flag", header: "FLAG", editField: "flag", width: 80 },
  { id: "region", header: "REGION", editField: "__region__", width: 110, region: true },
  { id: "open_location", header: "OPEN LOCATION", editField: "port_name", fallbacks: ["position", "area", "open"], width: 120 },
  { id: "opening_date", header: "OPENING DATE", editField: "open_date", fallbacks: ["when", "dates", "open"], width: 110 },
  { id: "cargo_history_combo", header: "CARGO HISTORY/L3C/LAST 3 CARGOES", editField: "cargo_history", width: 200 },
  { id: "tank_coating", header: "TANK COATING", editField: "tank_coating", fallbacks: ["coating", "coat"], width: 110 },
  { id: "sire_date", header: "SIRE DATE", editField: "sire_date", fallbacks: ["sire"], width: 100 },
  { id: "sire_location", header: "SIRE LOCATION", editField: "sire_location", width: 110 },
  { id: "cdi_date", header: "CDI DATE", editField: "cdi_date", fallbacks: ["cdi"], width: 100 },
  { id: "cdi_location", header: "CDI LOCATION", editField: "cdi_location", width: 110 },
  { id: "remarks", header: "REMARKS", editField: "remarks", fallbacks: ["remark", "comments", "comment"], width: 160 },
  { id: "other_info", header: "OTHER INFO", readOnly: true, width: 100 },
  { id: "q88", header: "Q88 AVAILABLE", editField: "q88", width: 100 },
  { id: "attachments", header: "ATTACHMENTS", readOnly: true, width: 180 },
  { id: "status", header: "STATUS", editField: "status", fallbacks: ["open_status"], width: 100 },
];

export const STANDARD_COLUMN_IDS = STANDARD_COLUMNS.map((c) => c.id);

const COL_BY_ID = Object.fromEntries(STANDARD_COLUMNS.map((c) => [c.id, c]));

export function headerForStandardColumn(id) {
  return COL_BY_ID[id]?.header ?? id.replace(/_/g, " ").toUpperCase();
}

export function editFieldForColumn(columnId) {
  const col = COL_BY_ID[columnId];
  if (!col || col.readOnly) return null;
  return col.editField ?? columnId;
}

export function isVesselNameColumn(id) {
  return Boolean(COL_BY_ID[id]?.vesselName);
}

export function isRegionColumn(id) {
  return Boolean(COL_BY_ID[id]?.region);
}

/** Resolve display text for a standard column. */
export function resolveStandardCellValue(vessel, columnId, rowNum = 1) {
  const dd = vessel?.dynamic_data || {};

  switch (columnId) {
    case "_num":
      return String(rowNum);
    case "imo":
      return extractImoNumber(dd);
    case "call_sign":
      return firstHit(dd, ["call_sign"]);
    case "vessel_name":
      return firstHit(dd, ["vessel_name", "name"]);
    case "year_built":
      return firstHit(dd, ["built", "yard_built", "when"]);
    case "vessel_type":
      return resolveVesselType(dd);
    case "cargo_type":
      return firstHit(dd, ["grade", "last_cargo", "cargo_preference"]);
    case "dwt_sdwt":
      return resolveDwtSdwt(dd);
    case "cbm":
      return firstHit(dd, ["cbm", "cubic", "cub", "cargo_tank_capacity", "total_cargo_tank_capacities_m3_98"]);
    case "draft":
      return firstHit(dd, ["draft", "sdraft", "sdwt_draft"]);
    case "flag":
      return firstHit(dd, ["flag"]);
    case "region":
      return vessel?.region ?? "";
    case "open_location":
      return resolveOpenFields(dd).location;
    case "opening_date":
      return resolveOpenFields(dd).date;
    case "cargo_history_combo":
      return resolveCargoHistory(dd);
    case "tank_coating":
      return firstHit(dd, ["tank_coating", "coating", "coat"]);
    case "sire_date":
      return firstHit(dd, ["sire_date", "sire"]);
    case "sire_location":
      return firstHit(dd, ["sire_location"]);
    case "cdi_date":
      return firstHit(dd, ["cdi_date", "cdi"]);
    case "cdi_location":
      return firstHit(dd, ["cdi_location"]);
    case "remarks":
      return firstHit(dd, ["remarks", "remark", "comments", "comment"]);
    case "other_info":
      return "";
    case "q88":
      return firstHit(dd, ["q88"]);
    case "attachments":
      return (vessel?.filename || "").replace(/\.eml$/i, "") || "";
    case "status":
      return firstHit(dd, ["status", "open_status"]);
    default:
      return dd[columnId] ?? "";
  }
}

/** Columns used in email HTML (no SR. NO — added separately). */
export const EMAIL_TABLE_COLUMNS = STANDARD_COLUMNS.filter((c) => c.id !== "_num");
