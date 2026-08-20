import { formatTextCasing } from "./fieldFormat";

/** Contact List columns — default: PIC first under company heading (Excel layout). */

const TEXT_CASE_CONTACT_KEYS = new Set([
  "contact_name",
  "company",
  "office_address",
  "country",
  "city",
  "trade",
  "designation",
  "department",
  "company_type",
  "role",
  "vessel_name",
  "other_info",
  "subject",
  "sender",
]);

/** Display casing — same Title Case rules as Vessel Position List. */
export function formatContactDisplay(key, value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  if (key === "email") return v.toLowerCase();
  if (key === "website_address") return v.replace(/\s+/g, "");
  if (
    key === "off_phone"
    || key === "mob_phone"
    || key === "fax"
    || key === "wechat"
    || key === "whatsapp"
    || key === "_sno"
    || key === "date_received"
    || key === "status"
    || key === "filename"
  ) {
    return v;
  }
  if (TEXT_CASE_CONTACT_KEYS.has(key)) {
    return formatTextCasing(key, v);
  }
  return v;
}


/** Pinned on horizontal scroll — PIC, address, country (not company). */
export const PINNED_CONTACT_KEYS = ["contact_name", "office_address", "country"];

/** Default data columns (no S.No., no company — company is the group heading). */
export const DEFAULT_CONTACT_COLUMNS = [
  {
    key: "contact_name",
    label: "PIC NAME",
    minW: 140,
    fieldKey: "contact_name",
    pinned: true,
    picCol: true,
  },
  {
    key: "office_address",
    label: "FULL ADDRESS",
    minW: 180,
    fieldKey: "office_address",
    pinned: true,
  },
  {
    key: "country",
    label: "COUNTRY",
    minW: 100,
    fieldKey: "country",
    pinned: true,
    pinEdge: true,
  },
  { key: "off_phone", label: "TELEPHONE", minW: 130, fieldKey: "off_phone" },
  { key: "mob_phone", label: "PIC MOBILE", minW: 120, fieldKey: "mob_phone" },
  { key: "email", label: "EMAIL", minW: 160, fieldKey: "email" },
  { key: "website_address", label: "WEBSITE", minW: 130, fieldKey: "website_address" },
  { key: "trade", label: "OWNERS / OPERATORS", minW: 160, fieldKey: "trade" },
  {
    key: "other_info",
    label: "REMARKS",
    minW: 200,
    fieldKey: "other_info",
  },
];

/** Extra fields when All columns is on (no company, source, or duplicate remarks). */
export const EXTRA_CONTACT_COLUMNS = [
  { key: "_sno", label: "S.NO.", minW: 52, readOnly: true, derived: true },
  { key: "designation", label: "DESIGNATION", minW: 110, fieldKey: "designation" },
  { key: "department", label: "DEPARTMENT", minW: 110, fieldKey: "department" },
  { key: "company_type", label: "COMPANY TYPE", minW: 100, fieldKey: "company_type" },
  { key: "vessel_name", label: "VESSEL NAME", minW: 140, fieldKey: "vessel_name" },
  { key: "city", label: "CITY", minW: 100, fieldKey: "city" },
  { key: "role", label: "ROLE", minW: 100, fieldKey: "role" },
  { key: "wechat", label: "WECHAT", minW: 90, fieldKey: "wechat" },
  { key: "whatsapp", label: "WHATSAPP", minW: 100, fieldKey: "whatsapp" },
  { key: "fax", label: "FAX", minW: 110, fieldKey: "fax" },
  { key: "status", label: "STATUS", minW: 110, fieldKey: "status", type: "status" },
];

/** Email trace fields — always last when All columns is on. */
export const CONTEXT_COLUMNS = [
  { key: "date_received", label: "LAST UPDATED", readOnly: true, minW: 120 },
  { key: "subject", label: "SUBJECT", readOnly: true, minW: 160 },
  { key: "sender", label: "SENDER", readOnly: true, minW: 140 },
  { key: "filename", label: "ATTACHMENT", readOnly: true, minW: 160 },
];

export const ALL_CONTACT_COLUMNS = [...DEFAULT_CONTACT_COLUMNS, ...EXTRA_CONTACT_COLUMNS];
export const ALL_COLUMNS = [
  ...DEFAULT_CONTACT_COLUMNS.filter((col) => col.key !== "other_info"),
  ...EXTRA_CONTACT_COLUMNS,
  {
    key: "other_info",
    label: "OTHER INFO",
    minW: 200,
    fieldKey: "other_info",
  },
  ...CONTEXT_COLUMNS,
];

export const DB_CONTACT_FIELDS = [
  "contact_name",
  "designation",
  "department",
  "company",
  "company_type",
  "vessel_name",
  "email",
  "off_phone",
  "mob_phone",
  "wechat",
  "whatsapp",
  "website_address",
  "office_address",
  "other_info",
  "status",
  "country",
  "city",
  "trade",
  "role",
  "fax",
];

export function contactCellValue(row, key, { formatDate, serialNo } = {}) {
  if (key === "_sno") return serialNo != null ? String(serialNo) : "";
  if (key === "date_received") return formatDate?.(row.date_received) ?? row.date_received ?? "";
  if (key === "status") {
    const s = String(row?.status ?? "").trim().toLowerCase();
    if (s === "inactive" || s === "in-active" || s === "in active") return "Inactive";
    return row?.status ? String(row.status) : "Active";
  }
  const raw = row?.[key] ?? "";
  return formatContactDisplay(key, raw);
}

export function buildContactSerialMap(rows, buildSourceSections) {
  const sections = buildSourceSections(rows);
  const map = new Map();
  let n = 0;
  for (const section of sections) {
    for (const group of section.groups) {
      for (const row of group.rows) {
        n += 1;
        map.set(row.contact_id, n);
      }
    }
  }
  return map;
}

export function buildPinnedOffsets(columns) {
  const offsets = {};
  let left = 0;
  for (const col of columns) {
    if (PINNED_CONTACT_KEYS.includes(col.key)) {
      offsets[col.key] = left;
      left += col.minW;
    }
  }
  return offsets;
}

export function patchContactField(row, colKey, value) {
  if (colKey === "_sno") return row;
  const col = ALL_CONTACT_COLUMNS.find((c) => c.key === colKey)
    || CONTEXT_COLUMNS.find((c) => c.key === colKey);
  const field = col?.fieldKey || colKey;
  return { ...row, [field]: value };
}
