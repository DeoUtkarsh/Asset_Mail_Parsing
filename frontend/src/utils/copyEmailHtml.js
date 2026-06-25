import { vesselsGroupedByZone, ZONE_ORDER } from "./zoneMapping";
import {
  STANDARD_COLUMNS,
  resolveStandardCellValue,
  hasDisplayValue,
  headerForStandardColumn,
} from "./standardColumns";

const MAX_COLS_PER_TABLE = 11;

const TH_STYLE =
  "background:#0369a1;color:#ffffff;padding:6px 8px;border:1px solid #475569;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;white-space:nowrap;text-align:left;vertical-align:top;";
const TD_STYLE =
  "padding:6px 8px;border:1px solid #cbd5e1;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#0c4a6e;vertical-align:top;word-wrap:break-word;";
const GROUP_ROW_STYLE =
  "background:#dbeafe;padding:6px 8px;border:1px solid #94a3b8;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#0c4a6e;";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pinColumns(allCols) {
  return ["_num", "imo", "vessel_name"].filter((k) => allCols.some((c) => c.id === k));
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
    '<p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#0c4a6e;">Dear Utkarsh,</p>',
    '<p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#0c4a6e;">Good day.</p>',
    '<p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#0c4a6e;">Please find below the latest vessel open positions consolidated from our network, grouped by trade zone.</p>',
  ].join("");
  const fallbackOutro = [
    '<p style="margin:14px 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#0c4a6e;">Should you require any further details, please do not hesitate to reach out.</p>',
    '<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#0c4a6e;">Best Regards</p>',
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
      if (!passedTables) intro.push(el.outerHTML);
      else outro.push(el.outerHTML);
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

function buildTableHtml(cols, vessels, zoneLabel, startRowNum) {
  const colCount = cols.length;

  const headerRow = cols
    .map((c) => `<th style="${TH_STYLE}">${escapeHtml(c.header)}</th>`)
    .join("");

  let rowNum = startRowNum;
  const bodyRows = vessels
    .map((v, i) => {
      const bg = i % 2 === 0 ? "#ffffff" : "#f1f5f9";
      const tds = cols
        .map((c) => {
          const raw = resolveStandardCellValue(v, c.id, rowNum);
          const text = hasDisplayValue(raw) ? escapeHtml(raw) : "—";
          const bold = c.id === "vessel_name" ? "font-weight:bold;" : "";
          return `<td style="${TD_STYLE}background:${bg};${bold}">${text}</td>`;
        })
        .join("");
      rowNum += 1;
      return `<tr>${tds}</tr>`;
    })
    .join("");

  return {
    html: [
      '<table border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;border:1px solid #94a3b8;table-layout:auto;">',
      "<tbody>",
      `<tr><td colspan="${colCount}" style="${GROUP_ROW_STYLE}">${escapeHtml(zoneLabel)}</td></tr>`,
      `<tr>${headerRow}</tr>`,
      bodyRows,
      "</tbody></table>",
    ].join(""),
    nextRowNum: rowNum,
  };
}

function buildZoneTables(zoneName, vessels, startRowNum) {
  const count = vessels.length;
  const baseLabel = `${zoneName} (${count} vessel${count !== 1 ? "s" : ""})`;
  const pin = pinColumns(STANDARD_COLUMNS);
  const chunks = splitColumnsForEmail(STANDARD_COLUMNS);

  const html = chunks
    .map((cols, idx) => {
      const label = idx === 0 ? baseLabel : continuedLabel(baseLabel, cols, pin);
      return buildTableHtml(cols, vessels, label, startRowNum).html;
    })
    .join("");

  return { html, nextRowNum: startRowNum + vessels.length };
}

export function buildContactListEmailHtml(fullHtml, vessels) {
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
      const { html, nextRowNum } = buildZoneTables(zone, byZone[zone], rowNum);
      rowNum = nextRowNum;
      return html;
    })
    .join("");

  return [introHtml, tables, outroHtml].join("");
}

function wrapHtmlDocument(fragment) {
  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8"></head><body>',
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

export async function copyEmailHtml(fullHtml, { vessels = [] } = {}) {
  const htmlFragment =
    vessels.length > 0
      ? buildContactListEmailHtml(fullHtml, vessels)
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
