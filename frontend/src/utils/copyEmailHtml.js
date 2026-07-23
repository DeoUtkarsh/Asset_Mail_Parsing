import { vesselsGroupedByZone, ZONE_ORDER } from "./zoneMapping";
import {
  STANDARD_COLUMNS,
  resolveStandardCellValue,
  hasDisplayValue,
  headerForStandardColumn,
} from "./standardColumns";

const MAX_COLS_PER_TABLE = 11;

/** Match Broker Sense UI tokens (index.css) — inline for Gmail/Outlook. */
const FONT = "Poppins,Inter,Arial,Helvetica,sans-serif";
const BRAND = "#219495";
const BRAND_D = "#1a7a7b";
const INK = "#132740";
const LINE = "#e5e7ea";
const MUTED_BG = "#f3f4f6";

const TH_STYLE =
  `background:${BRAND};color:#ffffff;padding:8px 10px;border:1px solid ${BRAND_D};` +
  `font-family:${FONT};font-size:11px;font-weight:600;letter-spacing:0.35px;` +
  "text-transform:uppercase;white-space:nowrap;text-align:left;vertical-align:top;";
const TD_BASE =
  `padding:8px 10px;border:1px solid ${LINE};font-family:${FONT};font-size:11.5px;` +
  `color:${INK};vertical-align:top;word-wrap:break-word;background:#ffffff;`;
const GROUP_ROW_STYLE =
  `background:${MUTED_BG};padding:8px 10px;border:1px solid ${LINE};` +
  `font-family:${FONT};font-size:11px;font-weight:700;color:${INK};text-transform:uppercase;`;
const P_STYLE =
  `margin:0 0 8px 0;font-family:${FONT};font-size:13px;color:${INK};line-height:1.55;`;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pinColumns(allCols) {
  return ["vessel_name", "imo", "region"].filter((k) => allCols.some((c) => c.id === k));
}

function splitColumnsForEmail(cols) {
  const ids = cols.map((c) => c.id);
  if (ids.length <= MAX_COLS_PER_TABLE) return [cols];

  const pin = pinColumns(cols);
  const pinCols = cols.filter((c) => pin.includes(c.id));
  const chunks = [cols.slice(0, MAX_COLS_PER_TABLE)];
  const used = new Set(chunks[0].map((c) => c.id));
  const remaining = cols.filter((c) => !used.has(c.id));

  let i = 0;
  while (i < remaining.length) {
    const slots = MAX_COLS_PER_TABLE - pinCols.length;
    chunks.push([...pinCols, ...remaining.slice(i, i + slots)]);
    i += slots;
  }
  return chunks;
}

function continuedLabel(baseLabel, cols, pin) {
  const pinSet = new Set(pin);
  const extra = cols.filter((c) => !pinSet.has(c.id));
  if (!extra.length) return `${baseLabel} (continued)`;
  return `${baseLabel} — ${extra[0].header} … ${extra[extra.length - 1].header}`;
}

function parseIntroOutroFromDraft(fullHtml) {
  const fallbackIntro = [
    `<p style="${P_STYLE}">Dear Utkarsh,</p>`,
    `<p style="${P_STYLE}">Good day.</p>`,
    `<p style="${P_STYLE}margin:0 0 14px 0;">Please find below the latest vessel open positions consolidated from our network, grouped by trade zone.</p>`,
  ].join("");
  const fallbackOutro = [
    `<p style="${P_STYLE}margin:14px 0 8px 0;">Should you require any further details, please do not hesitate to reach out.</p>`,
    `<p style="${P_STYLE}margin:0;">Best Regards</p>`,
  ].join("");

  if (!fullHtml) return { introHtml: fallbackIntro, outroHtml: fallbackOutro };

  try {
    const doc = new DOMParser().parseFromString(fullHtml, "text/html");
    const children = [...doc.body.children];
    const intro = [];
    const outro = [];
    let passedTables = false;

    for (const el of children) {
      if (el.tagName === "TABLE" || el.querySelector?.("table")) {
        passedTables = true;
        continue;
      }
      if (el.tagName !== "P") continue;
      // Re-style pasted intro/outro so Gmail matches UI (strip old blue sky styles).
      const text = (el.textContent || "").trim();
      if (!text) continue;
      const styled = `<p style="${P_STYLE}${passedTables && outro.length === 0 ? "margin:14px 0 8px 0;" : ""}">${escapeHtml(text)}</p>`;
      if (!passedTables) intro.push(styled);
      else outro.push(styled);
    }

    return {
      introHtml: intro.length ? intro.join("") : fallbackIntro,
      outroHtml: outro.length ? outro.join("") : fallbackOutro,
    };
  } catch {
    return { introHtml: fallbackIntro, outroHtml: fallbackOutro };
  }
}

function plainFromHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.innerText || tmp.textContent || "").trim();
}

function cellStyleForColumn(colId) {
  if (colId === "vessel_name") {
    return `${TD_BASE}font-weight:700;color:${INK};text-transform:uppercase;`;
  }
  if (colId === "region") {
    return `${TD_BASE}font-weight:700;color:${BRAND_D};`;
  }
  return TD_BASE;
}

function buildTableHtml(cols, vessels, zoneLabel, startRowNum) {
  const colCount = cols.length;

  const headerRow = cols
    .map((c) => `<th style="${TH_STYLE}">${escapeHtml(c.header)}</th>`)
    .join("");

  let rowNum = startRowNum;
  const bodyRows = vessels
    .map((v) => {
      const tds = cols
        .map((c) => {
          const raw = resolveStandardCellValue(v, c.id, rowNum);
          const text = hasDisplayValue(raw) ? escapeHtml(raw) : "—";
          return `<td style="${cellStyleForColumn(c.id)}">${text}</td>`;
        })
        .join("");
      rowNum += 1;
      return `<tr>${tds}</tr>`;
    })
    .join("");

  return {
    html: [
      `<table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 14px 0;font-family:${FONT};border:1px solid ${LINE};table-layout:auto;">`,
      "<tbody>",
      `<tr><td colspan="${colCount}" style="${GROUP_ROW_STYLE}">${escapeHtml(zoneLabel)}</td></tr>`,
      `<tr>${headerRow}</tr>`,
      bodyRows,
      "</tbody></table>",
    ].join(""),
    nextRowNum: rowNum,
  };
}

function buildZoneTables(zoneName, vessels, startRowNum, columns) {
  const count = vessels.length;
  const baseLabel = `${zoneName} (${count} vessel${count !== 1 ? "s" : ""})`;
  const cols = columns?.length ? columns : STANDARD_COLUMNS;
  const pin = pinColumns(cols);
  const chunks = splitColumnsForEmail(cols);

  const html = chunks
    .map((chunkCols, idx) => {
      const label = idx === 0 ? baseLabel : continuedLabel(baseLabel, chunkCols, pin);
      return buildTableHtml(chunkCols, vessels, label, startRowNum).html;
    })
    .join("");

  return { html, nextRowNum: startRowNum + vessels.length };
}

export function buildContactListEmailHtml(fullHtml, vessels, columns = STANDARD_COLUMNS) {
  const { introHtml, outroHtml } = parseIntroOutroFromDraft(fullHtml);
  const grouped = vesselsGroupedByZone(vessels || []);

  const byZone = {};
  for (const v of grouped) {
    const z = v.filename || v.attachment_id || "UNSPECIFIED";
    if (!byZone[z]) byZone[z] = [];
    byZone[z].push(v);
  }

  let rowNum = 1;
  const tables = ZONE_ORDER.filter((z) => byZone[z]?.length)
    .map((zone) => {
      const { html, nextRowNum } = buildZoneTables(zone, byZone[zone], rowNum, columns);
      rowNum = nextRowNum;
      return html;
    })
    .join("");

  return [introHtml, tables, outroHtml].join("");
}

function wrapHtmlDocument(fragment) {
  return [
    "<!DOCTYPE html>",
    "<html><head><meta charset=\"utf-8\">",
    `<style>body{font-family:${FONT};color:${INK};}</style>`,
    "</head><body>",
    "<!--StartFragment-->",
    fragment,
    "<!--EndFragment-->",
    "</body></html>",
  ].join("");
}

async function writeClipboard(htmlFragment, plainText) {
  const htmlDoc = wrapHtmlDocument(htmlFragment);

  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      const htmlBlob = new Blob([htmlDoc], { type: "text/html" });
      const plainBlob = new Blob([plainText], { type: "text/plain" });
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": htmlBlob,
          "text/plain": plainBlob,
        }),
      ]);
      return;
    } catch {
      /* fall through */
    }
  }

  await new Promise((resolve, reject) => {
    const onCopy = (e) => {
      e.preventDefault();
      e.clipboardData.clearData();
      e.clipboardData.setData("text/html", htmlDoc);
      e.clipboardData.setData("text/plain", plainText);
    };

    document.addEventListener("copy", onCopy, { once: true });

    const ta = document.createElement("textarea");
    ta.value = plainText;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;";
    document.body.appendChild(ta);
    ta.select();

    try {
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("Copy failed"));
    } catch (err) {
      document.body.removeChild(ta);
      reject(err);
    }
  });
}

export async function copyEmailHtml(fullHtml, { vessels = [], columns = null } = {}) {
  const colDefs = columns?.length ? columns : STANDARD_COLUMNS;
  const htmlFragment =
    vessels.length > 0
      ? buildContactListEmailHtml(fullHtml, vessels, colDefs)
      : (() => {
          const doc = new DOMParser().parseFromString(fullHtml || "", "text/html");
          return doc.body?.innerHTML || fullHtml || "";
        })();

  if (!htmlFragment?.trim()) throw new Error("Nothing to copy");

  const { introHtml, outroHtml } = parseIntroOutroFromDraft(fullHtml);
  const plainText = [plainFromHtml(introHtml), plainFromHtml(outroHtml)]
    .filter(Boolean)
    .join("\n\n");

  await writeClipboard(htmlFragment, plainText);
}

export { STANDARD_COLUMNS, headerForStandardColumn };
