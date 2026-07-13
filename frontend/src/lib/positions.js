// Shared helpers for interpreting parsed vessel "positions".
// In this first working version, confidence is a PROXY: a position is
// "flagged / needs review" when it has no clean open region (UNSPECIFIED),
// unless the user has already confirmed it (is_validated). Real per-field
// confidence from the LLM will replace this proxy later.

export const UNKNOWN_REGION = "UNSPECIFIED";

// Standard position-list columns (mirrors the backend drafter COLUMN_MAP).
export const STD_COLUMNS = [
  { header: "VESSEL", keys: ["vessel_name", "name"] },
  { header: "DWT", keys: ["dwt", "sdwt"] },
  { header: "BUILT", keys: ["built"] },
  { header: "COATING", keys: ["coating", "tank_type", "tank_coating"] },
  { header: "IMO", keys: ["imo_type", "imo"] },
  { header: "OPEN", keys: ["open_location", "open"] },
  { header: "OPEN DATE", keys: ["open_date", "opening_date", "dates", "date"] },
  { header: "SEEKING", keys: ["seeking", "basis", "eta_foc"] },
  { header: "CAPACITY", keys: ["cargo_tank_cap", "cargo_tank_capacity", "cbm", "dwt_cbm"] },
  { header: "LAST CARGO", keys: ["last_3_cargoes", "last_3_cargos", "last_cargos", "last_cargo"] },
  { header: "SIRE", keys: ["sire", "sire_valid"] },
  { header: "L3C", keys: ["l3c"] },
  { header: "COMMENTS", keys: ["comments"] },
];

export function regionUnknown(region) {
  if (!region) return true;
  const r = String(region).trim();
  return r === "" || r.toUpperCase() === UNKNOWN_REGION;
}

/** A position still needs a human look when its region is unknown and it isn't confirmed yet. */
export function needsReview(v) {
  return !v.is_validated && regionUnknown(v.region);
}

export function vesselName(v) {
  const d = v.dynamic_data || {};
  return d.vessel_name || d.vessel || d.name || "(unnamed vessel)";
}

/** Confidence proxy for a set of positions: share that are NOT flagged. */
export function confidencePct(vessels) {
  if (!vessels.length) return 100;
  const ok = vessels.filter((v) => !needsReview(v)).length;
  return Math.round((ok / vessels.length) * 100);
}

export function confBand(pct) {
  if (pct >= 90) return "hi";
  if (pct >= 70) return "mid";
  return "lo";
}

const titleCase = (s) => s.replace(/[-_.]/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

/** Display name from a real "From" header, e.g. '"Phuong Pham" <daisy@x.com>' → "Phuong Pham". */
export function parseFromName(from) {
  if (!from) return null;
  const named = from.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>/);
  if (named && named[1].trim()) return named[1].trim();
  const addr = from.match(/([a-z0-9._%+-]+)@([a-z0-9-]+)/i);
  if (addr) return titleCase(addr[2]);
  return from.trim() || null;
}

/** Derive an email-client-style { sender, subject, snippet, hasAttachment } from the raw body text. */
export function deriveEmail(raw) {
  const text = (raw || "").replace(/\r/g, "");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const isGreeting = (l) => /^(dear|hi|hello|good\s+(day|morning|afternoon|evening)|greetings|to whom|respected)/i.test(l);
  const isNoise = (l) =>
    l.length < 6 ||
    /^\[/.test(l) ||
    /^(cid:|image\d)/i.test(l) ||
    /^(vessel|dwt|built|imo|coat(ing)?|position|comment|cbm|port|date|remarks|flag|open)$/i.test(l);
  const clean = (l) => l.replace(/\[cid:[^\]]+\]/gi, "").replace(/\[image[^\]]*\]/gi, "").replace(/\s+/g, " ").trim();
  const subject = (lines.map(clean).find((l) => l && !isGreeting(l) && !isNoise(l)) || "Vessel positions").slice(0, 72);
  const snippet = lines.filter((l) => !isGreeting(l)).join(" ")
    .replace(/\[cid:[^\]]+\]/gi, "").replace(/\[image[^\]]*\]/gi, "").replace(/\s+/g, " ").trim().slice(0, 130);

  // best-effort sender: from a REAL email address' domain (skip cid/image refs), else a signature name
  let sender = null;
  const emails = [...text.matchAll(/([a-z0-9._%+-]+)@([a-z0-9-]+)\.([a-z]{2,})/gi)];
  const real = emails.find((m) => {
    const local = m[1].toLowerCase(), domain = m[2].toLowerCase();
    if (/image|\.png|\.jpg|\.gif|cid/.test(local)) return false;      // Content-ID reference, not a sender
    if (!/[a-z]/.test(domain) || /^[0-9a-f]{6,}$/.test(domain)) return false; // hex/cid domain
    return true;
  });
  if (real) sender = titleCase(real[2]);
  if (!sender) {
    const sig = text.match(/(?:^|\n)\s*(?:regards|thanks|thank you|best regards|br|sincerely|cheers)[,!.\s]*\n+\s*([A-Za-z][A-Za-z .&'-]{2,34})/i);
    if (sig) sender = sig[1].trim();
  }
  if (!sender) sender = "Vessel Owner";

  const hasAttachment = /q88\b|attach(ed|ment)|enclosed|pls\s+find|please\s+find|\.pdf|\.xls/i.test(text);
  return { sender, subject, snippet, hasAttachment };
}

/** Group positions by attachment id → { attachment_id, filename, vessels, flagged }. */
export function byAttachment(vessels) {
  const map = new Map();
  for (const v of vessels) {
    const key = v.attachment_id || "?";
    if (!map.has(key)) map.set(key, { attachment_id: key, filename: v.filename || key, vessels: [], flagged: 0 });
    const g = map.get(key);
    g.vessels.push(v);
    if (needsReview(v)) g.flagged += 1;
  }
  return [...map.values()];
}
