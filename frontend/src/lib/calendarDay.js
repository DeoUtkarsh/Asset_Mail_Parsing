/** Calendar-day helpers for inbox day nav + Home "today" scope. */

/** AWS CloudFront (and similar) → UTC calendar day; local/dev → browser local. */
export function useUtcCalendar() {
  if (typeof window === "undefined" || !window.location) return false;
  const host = window.location.hostname || "";
  return /\.cloudfront\.net$/i.test(host) || /\.amazonaws\.com$/i.test(host);
}

/** IANA tz for Home API (UTC on AWS host, else browser zone). */
export function homeTimeZone() {
  if (useUtcCalendar()) return "UTC";
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** YYYY-MM-DD for a Date in UTC or local calendar. */
export function calendarDayKey(date = new Date(), useUtc = useUtcCalendar()) {
  if (useUtc) return date.toISOString().slice(0, 10);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** YYYY-MM-DD for an ISO timestamp in UTC or local calendar. */
export function isoToDayKey(iso, useUtc = useUtcCalendar()) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return calendarDayKey(date, useUtc);
}

/** Shift a YYYY-MM-DD key by `delta` days. */
export function shiftDayKey(dayKey, delta, useUtc = useUtcCalendar()) {
  const [y, m, d] = String(dayKey).split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  if (useUtc) {
    const dt = new Date(Date.UTC(y, m - 1, d + delta));
    return calendarDayKey(dt, true);
  }
  const dt = new Date(y, m - 1, d + delta);
  return calendarDayKey(dt, false);
}

/** Short label e.g. "Mon, 3 Aug 2026". */
export function formatDayLabel(dayKey, useUtc = useUtcCalendar()) {
  const [y, m, d] = String(dayKey).split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  const date = useUtc
    ? new Date(Date.UTC(y, m - 1, d, 12))
    : new Date(y, m - 1, d, 12);
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: useUtc ? "UTC" : undefined,
  });
}
