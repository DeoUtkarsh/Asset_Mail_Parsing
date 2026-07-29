/** Display / canonicalize helpers for opening dates, DWT/CBM, and year built. */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_INDEX = (() => {
  const map = {};
  MONTHS.forEach((name, i) => {
    map[name.toLowerCase()] = i;
    map[name.slice(0, 3).toLowerCase()] = i;
  });
  map.sept = 8;
  return map;
})();

const SMALL_WORDS = new Set(["of", "the", "a", "an", "and", "to", "for", "in", "on", "at"]);
const ORDINAL_WORDS = new Set(["st", "nd", "rd", "th"]);

/** Lowercase ordinals and glue "23 Rd" → "23rd". */
function normalizeDateOrdinals(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/\b(st|nd|rd|th)\b/gi, (m) => m.toLowerCase());
  s = s.replace(/(\d)\s+(st|nd|rd|th)\b/gi, "$1$2");
  return s;
}

function dayWithOrdinal(n) {
  const d = Number(n);
  if (!Number.isFinite(d)) return String(n);
  const mod100 = d % 100;
  const mod10 = d % 10;
  let suf = "th";
  if (mod100 < 11 || mod100 > 13) {
    if (mod10 === 1) suf = "st";
    else if (mod10 === 2) suf = "nd";
    else if (mod10 === 3) suf = "rd";
  }
  return `${d}${suf}`;
}

function expandTwoDigitYear(yy) {
  const n = Number(yy);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 99) return null;
  return n <= 49 ? 2000 + n : 1900 + n;
}

function normalizeYear(y) {
  const n = Number(String(y).replace(/[^\d]/g, ""));
  if (!Number.isFinite(n)) return null;
  if (n >= 1000 && n <= 2100) return n;
  if (n >= 0 && n <= 99) return expandTwoDigitYear(n);
  return null;
}

function currentYear() {
  return new Date().getFullYear();
}

/** Title-case free text; keep small words + ordinals lowercase. "end of july" → "End of July". */
export function formatOpenPositionText(raw) {
  const s = normalizeDateOrdinals(raw);
  if (!s) return "";
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((word, i) => {
      const bare = word.replace(/[^a-z]/gi, "");
      if (MONTH_INDEX[bare] != null) {
        const m = MONTHS[MONTH_INDEX[bare]];
        return word.replace(new RegExp(bare, "i"), m);
      }
      if (ORDINAL_WORDS.has(bare)) return word.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(bare)) return word.toLowerCase();
      // Avoid capitalizing the "r" in "23rd" (digit/letter boundary).
      return word
        .replace(/(^|[^0-9a-z])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase())
        .replace(/(\d)(st|nd|rd|th)\b/gi, (_, d, suf) => d + suf.toLowerCase());
    })
    .join(" ");
}

function formatDayMonthYear(day, monthIdx, year) {
  const d = Number(day);
  const y = normalizeYear(year) ?? currentYear();
  if (!Number.isFinite(d) || d < 1 || d > 31) return null;
  if (monthIdx == null || monthIdx < 0 || monthIdx > 11) return null;
  return `${d} ${MONTHS[monthIdx]} ${y}`;
}

/**
 * Parse a single concrete date fragment into "19 July 2026".
 * Accepts: 19/07/26, 19-07-2026, 19-July, July 19, 19 July 2026, etc.
 */
function parseOneDate(fragment) {
  const s = String(fragment || "").trim().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!s) return null;

  // 19/07/26 | 19-07-2026 | 19.07.26
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    return formatDayMonthYear(day, month, m[3]);
  }

  // 19-July | 19 July | 19-Jul-26 | 19 Jul 2026
  m = s.match(/^(\d{1,2})[-\s]+([A-Za-z]+)(?:[-\s]+(\d{2,4}))?$/);
  if (m && MONTH_INDEX[m[2].toLowerCase()] != null) {
    return formatDayMonthYear(m[1], MONTH_INDEX[m[2].toLowerCase()], m[3] || currentYear());
  }

  // July 19 | July 19 2026 | Jul-19-26
  m = s.match(/^([A-Za-z]+)[-\s]+(\d{1,2})(?:[-\s]+(\d{2,4}))?$/);
  if (m && MONTH_INDEX[m[1].toLowerCase()] != null) {
    return formatDayMonthYear(m[2], MONTH_INDEX[m[1].toLowerCase()], m[3] || currentYear());
  }

  // Already "19 July 2026" (maybe short month)
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{2,4})$/);
  if (m && MONTH_INDEX[m[2].toLowerCase()] != null) {
    return formatDayMonthYear(m[1], MONTH_INDEX[m[2].toLowerCase()], m[3]);
  }

  return null;
}

/**
 * Opening / open position date:
 * - Concrete dates → "19 July 2026"
 * - Day ranges → "20-21 March 2026"
 * - Free text (e.g. "end of july") → "End of July"
 * Ordinal suffixes stay lowercase (23rd, not 23Rd).
 */
export function formatOpeningDate(raw) {
  const s = normalizeDateOrdinals(raw);
  if (!s) return "";

  // 20-21 Mar 2026 | 20/21 March 2026 | 22-23rd July 2026
  let m = s.match(
    /^(\d{1,2})(?:st|nd|rd|th)?\s*[-/–—]\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:\s+(\d{2,4}))?$/i
  );
  if (m && MONTH_INDEX[m[3].toLowerCase()] != null) {
    const y = normalizeYear(m[4] || currentYear());
    const end = /(?:st|nd|rd|th)/i.test(s) ? dayWithOrdinal(m[2]) : String(Number(m[2]));
    return `${Number(m[1])}-${end} ${MONTHS[MONTH_INDEX[m[3].toLowerCase()]]} ${y}`;
  }

  // 20-21/03/26
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s*[-/]\s*(\d{1,2})(?:st|nd|rd|th)?[/.-](\d{1,2})[/.-](\d{2,4})$/i);
  if (m) {
    const month = Number(m[3]) - 1;
    const y = normalizeYear(m[4]);
    if (month >= 0 && month <= 11 && y) {
      const end = /(?:st|nd|rd|th)/i.test(s) ? dayWithOrdinal(m[2]) : String(Number(m[2]));
      return `${Number(m[1])}-${end} ${MONTHS[month]} ${y}`;
    }
  }

  // Single day with ordinal: 23rd July 2026
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)(?:\s+(\d{2,4}))?$/i);
  if (m && MONTH_INDEX[m[2].toLowerCase()] != null) {
    const y = normalizeYear(m[3] || currentYear());
    return `${dayWithOrdinal(m[1])} ${MONTHS[MONTH_INDEX[m[2].toLowerCase()]]} ${y}`;
  }

  const one = parseOneDate(s.replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1"));
  if (one) return one;

  // Looks like it has a digit date attempt but failed — still title-case
  return formatOpenPositionText(s);
}

/** Round numeric tokens and add thousand separators. 19000.19 → "19,000". */
export function formatRoundedFigures(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.replace(/[\d,]+(?:\.\d+)?/g, (token) => {
    const n = Number(String(token).replace(/,/g, ""));
    if (!Number.isFinite(n)) return token;
    return Math.round(n).toLocaleString("en-US");
  });
}

/**
 * DWT/SDWT: expand k-suffix (160k → 160000) without flagging as AI-scaled;
 * bare values under 1000 are ×1000 shorthand (49 → 49,000) and marked scaled.
 * Returns { value, scaled }.
 */
export function formatDwtSdwt(raw) {
  const s0 = String(raw || "").trim();
  if (!s0) return { value: "", scaled: false };
  let hadK = false;
  const s = s0.replace(/([\d,]+(?:\.\d+)?)\s*[kK]\b/g, (_, num) => {
    hadK = true;
    const n = Number(String(num).replace(/,/g, ""));
    if (!Number.isFinite(n)) return _;
    return String(Math.round(n * 1000));
  });
  let scaled = false;
  const value = s.replace(/[\d,]+(?:\.\d+)?/g, (token) => {
    let n = Number(String(token).replace(/,/g, ""));
    if (!Number.isFinite(n)) return token;
    if (n > 0 && n < 1000) {
      n *= 1000;
      scaled = true;
    }
    return Math.round(n).toLocaleString("en-US");
  });
  return { value, scaled: hadK && !scaled ? false : scaled };
}

/** CBM/cubic: same ×1000 shorthand as DWT; whole numbers. */
export function formatCbm(raw) {
  return formatDwtSdwt(raw);
}

/** Year built: 96 → 1996, 16 → 2016, already-4-digit left as-is. */
export function formatYearBuilt(raw) {
  const s = String(raw || "").trim();
  if (!s) return { value: "", expanded: false };
  const m4 = s.match(/\b(\d{4})\b/);
  if (m4) {
    const y = normalizeYear(m4[1]);
    return { value: y == null ? s : String(y), expanded: false };
  }
  const m2 = s.match(/\b(\d{1,2})\b/);
  if (!m2) return { value: s, expanded: false };
  const y = normalizeYear(m2[1]);
  if (y == null) return { value: s, expanded: false };
  return { value: String(y), expanded: true };
}

export function parseAiNormalized(raw) {
  const s = String(raw || "").trim();
  if (!s) return new Set();
  return new Set(s.split(",").map((p) => p.trim()).filter(Boolean));
}

export function formatAiNormalized(flags) {
  return [...flags].filter(Boolean).sort().join(",");
}

const TEXT_CASE_KEYS = new Set([
  "vessel_name",
  "company",
  "vessel_type",
  "cargo_type",
  "flag",
  "open_location",
  "direction",
  "tank_coating",
  "eta_foc",
  "sire_location",
  "cdi_location",
  "cargo_history_combo",
  "status",
  "remarks",
  "other_info",
]);

const VESSEL_TYPE_CANONICAL = [
  "Oil Tanker",
  "Chemical Tanker",
  "Bulk Carrier",
  "Chem/Prod Tanker",
  "Container",
  "LPG Carrier (Refri)",
  "LNG Carrier",
  "Cement Carrier",
  "Asphalt / Bitumen Tanker",
  "LPG Carrier (Press)",
  "Gen Cargo / Multi-Purpose Vessel",
  "Dredger",
  "Offshore Support Vessel",
  "Tug Boat",
  "Others",
];

const VESSEL_TYPE_ALIASES = {
  "general cargo": "Gen Cargo / Multi-Purpose Vessel",
  "gen cargo": "Gen Cargo / Multi-Purpose Vessel",
  mpp: "Gen Cargo / Multi-Purpose Vessel",
  "multi purpose": "Gen Cargo / Multi-Purpose Vessel",
  multipurpose: "Gen Cargo / Multi-Purpose Vessel",
  "chem tanker": "Chemical Tanker",
  chemical: "Chemical Tanker",
  oil: "Oil Tanker",
  "product tanker": "Chem/Prod Tanker",
  "prod tanker": "Chem/Prod Tanker",
};

const SMALL_CASE_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "via"]);
const COMPANY_TOKENS = new Set(["pte", "ltd", "llc", "inc", "corp", "co", "sa", "plc", "gmbh", "bv", "nv", "ag"]);

function titleCaseText(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const parts = s.split(/(\s+)/);
  let wordI = 0;
  return parts
    .map((part) => {
      if (!part || /^\s+$/.test(part)) return part;
      const out = titleCaseWord(part, wordI);
      wordI += 1;
      return out;
    })
    .join("");
}

function titleCaseWord(word, index) {
  if (!word) return word;
  if (/^([A-Za-z]\.){1,}[A-Za-z]?\.?$/.test(word)) return word.toUpperCase();
  if (word.includes("/") && /^[A-Za-z0-9]{1,5}(\/[A-Za-z0-9]{1,5})*$/.test(word) && word.length <= 11) {
    return word.toUpperCase();
  }
  const letters = word.replace(/[^A-Za-z]/g, "");
  if (letters && letters === letters.toUpperCase() && letters.length >= 2 && letters.length <= 3 && !word.includes(".")) {
    if (index > 0 || !/[aeiouAEIOU]/.test(letters)) return word.toUpperCase();
  }
  const bare = word.toLowerCase().replace(/[^a-z]/g, "");
  if (index > 0 && SMALL_CASE_WORDS.has(bare)) return word.toLowerCase();
  if (index > 0 && COMPANY_TOKENS.has(bare)) return bare.length <= 3 ? word.toUpperCase() : bare[0].toUpperCase() + bare.slice(1);

  return word.replace(/[A-Za-z]+/g, (chunk) => chunk[0].toUpperCase() + chunk.slice(1).toLowerCase());
}

function formatVesselNameCase(raw) {
  let s = titleCaseText(raw);
  s = s.replace(/^(M\s*\/\s*T)\b/i, "M/T");
  s = s.replace(/^(M\s*\/\s*V)\b/i, "M/V");
  s = s.replace(/^(MT)\b/i, "MT");
  s = s.replace(/^(MV)\b/i, "MV");
  return s;
}

function formatVesselTypeCase(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const key = s.replace(/\s+/g, " ").toLowerCase();
  const hit = VESSEL_TYPE_CANONICAL.find((t) => t.toLowerCase() === key);
  if (hit) return hit;
  if (VESSEL_TYPE_ALIASES[key]) return VESSEL_TYPE_ALIASES[key];
  return titleCaseText(s);
}

function formatDirectionCase(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const compact = s.replace(/\s+/g, "");
  if (/^[A-Za-z0-9]{1,5}(\/[A-Za-z0-9]{1,5})*$/.test(compact) && compact.length <= 8) {
    return compact.toUpperCase();
  }
  return titleCaseText(s);
}

function formatCoatingCase(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const compact = s.replace(/\s+/g, "");
  if (/^[A-Za-z0-9]{1,5}(\/[A-Za-z0-9]{1,5})*$/.test(compact) && compact.length <= 12) {
    return compact.toUpperCase();
  }
  return titleCaseText(s);
}

function formatLongTextCase(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) return titleCaseText(s);
  return s;
}

/** Title-case / code casing for text grid fields (matches backend). */
export function formatTextCasing(key, value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  if (key === "vessel_name") return formatVesselNameCase(v);
  if (key === "vessel_type") return formatVesselTypeCase(v);
  if (key === "direction") return formatDirectionCase(v);
  if (key === "tank_coating") return formatCoatingCase(v);
  if (key === "remarks" || key === "other_info") return formatLongTextCase(v);
  return titleCaseText(v);
}

/** Apply field formatting; for DWT also returns whether ×1000 scaling ran. */
export function formatStandardField(key, value) {
  const v = value == null ? "" : String(value);
  if (!v.trim()) return "";
  if (key === "opening_date" || key === "open_date") return formatOpeningDate(v);
  if (key === "dwt_sdwt" || key === "dwt" || key === "sdwt") return formatDwtSdwt(v).value;
  if (key === "cbm") return formatCbm(v).value;
  if (key === "year_built" || key === "built") return formatYearBuilt(v).value;
  if (key === "imo" || key === "imo_no" || key === "call_sign" || key === "imo_type") return v.trim();
  if (TEXT_CASE_KEYS.has(key)) return formatTextCasing(key, v);
  return v;
}

/** True when this vessel's dynamic_data marks the column as AI-normalized. */
export function isAiNormalizedField(vessel, columnId) {
  const flags = parseAiNormalized(vessel?.dynamic_data?.ai_normalized);
  if (columnId === "dwt" || columnId === "sdwt") return flags.has("dwt_sdwt") || flags.has(columnId);
  return flags.has(columnId);
}
