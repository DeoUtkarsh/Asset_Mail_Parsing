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

/** Title-case free text; keep small words lowercase mid-phrase. "end of july" → "End of July". */
export function formatOpenPositionText(raw) {
  const s = String(raw || "").trim();
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
      if (i > 0 && SMALL_WORDS.has(bare)) return word.toLowerCase();
      return word.replace(/\b[a-z]/, (c) => c.toUpperCase());
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
 */
export function formatOpeningDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  // 20-21 Mar 2026 | 20/21 March 2026
  let m = s.match(
    /^(\d{1,2})\s*[-/]\s*(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{2,4}))?$/i
  );
  if (m && MONTH_INDEX[m[3].toLowerCase()] != null) {
    const y = normalizeYear(m[4] || currentYear());
    return `${Number(m[1])}-${Number(m[2])} ${MONTHS[MONTH_INDEX[m[3].toLowerCase()]]} ${y}`;
  }

  // 20-21/03/26
  m = s.match(/^(\d{1,2})\s*[-/]\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const month = Number(m[3]) - 1;
    const y = normalizeYear(m[4]);
    if (month >= 0 && month <= 11 && y) {
      return `${Number(m[1])}-${Number(m[2])} ${MONTHS[month]} ${y}`;
    }
  }

  const one = parseOneDate(s);
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
 * DWT/SDWT: values under 1000 are treated as ×1000 shorthand (49 → 49,000),
 * then rounded with thousand separators.
 * Returns { value, scaled }.
 */
export function formatDwtSdwt(raw) {
  const s = String(raw || "").trim();
  if (!s) return { value: "", scaled: false };
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
  return { value, scaled };
}

/** Year built: 96 → 1996, 16 → 2016, already-4-digit left as-is. */
export function formatYearBuilt(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  // Prefer a clear year token
  const m = s.match(/\b(\d{4})\b/) || s.match(/\b(\d{1,2})\b/);
  if (!m) return s;
  const y = normalizeYear(m[1]);
  if (y == null) return s;
  return String(y);
}

export function parseAiNormalized(raw) {
  const s = String(raw || "").trim();
  if (!s) return new Set();
  return new Set(s.split(",").map((p) => p.trim()).filter(Boolean));
}

export function formatAiNormalized(flags) {
  return [...flags].filter(Boolean).sort().join(",");
}

/** Apply field formatting; for DWT also returns whether ×1000 scaling ran. */
export function formatStandardField(key, value) {
  const v = value == null ? "" : String(value);
  if (!v.trim()) return "";
  if (key === "opening_date" || key === "open_date") return formatOpeningDate(v);
  if (key === "dwt_sdwt" || key === "dwt" || key === "sdwt") return formatDwtSdwt(v).value;
  if (key === "cbm") return formatRoundedFigures(v);
  if (key === "year_built" || key === "built") return formatYearBuilt(v);
  return v;
}

/** True when this vessel's dynamic_data marks the column as AI-normalized. */
export function isAiNormalizedField(vessel, columnId) {
  const flags = parseAiNormalized(vessel?.dynamic_data?.ai_normalized);
  if (columnId === "dwt" || columnId === "sdwt") return flags.has("dwt_sdwt") || flags.has(columnId);
  return flags.has(columnId);
}
