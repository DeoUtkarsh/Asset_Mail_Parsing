import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import html2canvas from "html2canvas";
import L from "leaflet";
import { ZONE_ORDER, regionToZone } from "./zoneMapping";
import { mapViewFromZones, leafletBoundsFromZones } from "./mapBounds";
import {
  resolveStandardCellValue,
  hasDisplayValue,
} from "./standardColumns";

const ZONE_COLORS = {
  "STRAITS/SEA": [14, 165, 233],
  "FAR EAST": [245, 158, 11],
  INDIA: [16, 185, 129],
  "AG/MIDDLE EAST": [139, 92, 246],
  "MED/BLACK SEA": [20, 184, 166],
  EUROPE: [59, 130, 246],
  AFRICA: [239, 68, 68],
  AMERICAS: [249, 115, 22],
  OCEANIA: [236, 72, 153],
  UNSPECIFIED: [148, 163, 184],
};

const ZONE_COLORS_CSS = {
  "STRAITS/SEA": "#0ea5e9",
  "FAR EAST": "#f59e0b",
  INDIA: "#10b981",
  "AG/MIDDLE EAST": "#8b5cf6",
  "MED/BLACK SEA": "#14b8a6",
  EUROPE: "#3b82f6",
  AFRICA: "#ef4444",
  AMERICAS: "#f97316",
  OCEANIA: "#ec4899",
  UNSPECIFIED: "#94a3b8",
};

function groupVesselsByZone(vessels) {
  /** Group by trade zone from region — same logic as the draft email, not attachment filename. */
  const byZone = {};
  for (const v of vessels || []) {
    const zone = regionToZone(v.region);
    if (!byZone[zone]) byZone[zone] = [];
    byZone[zone].push(v);
  }
  return byZone;
}

function orderedZoneKeys(byZone) {
  const keys = ZONE_ORDER.filter((z) => byZone[z]?.length);
  for (const z of Object.keys(byZone)) {
    if (!ZONE_ORDER.includes(z) && byZone[z]?.length) keys.push(z);
  }
  return keys;
}

function mercatorXY(lat, lng, zoom) {
  const n = 2 ** zoom;
  const x = ((lng + 180) / 360) * 256 * n;
  const sin = Math.sin((lat * Math.PI) / 180);
  const clamped = Math.max(Math.min(sin, 0.9999), -0.9999);
  const y =
    (0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI)) * 256 * n;
  return { x, y };
}

/**
 * Always-available map for PDF: ocean background + zone pins.
 * Avoids Leaflet tile CORS / collapsed-panel capture failures.
 */
function renderZonesMapImage(zones, width = 1100, height = 360) {
  if (typeof document === "undefined" || !zones?.length) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const view = mapViewFromZones(zones);
  const center = mercatorXY(view.lat, view.lng, view.zoom);

  // Ocean / map panel
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, "#c5e4f0");
  grad.addColorStop(1, "#9ec9dc");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Soft grid (map feel without external tiles)
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const x = (width / 8) * i;
    const y = (height / 6) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    if (i < 6) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  const toPx = (lat, lng) => {
    const p = mercatorXY(lat, lng, view.zoom);
    return {
      x: width / 2 + (p.x - center.x),
      y: height / 2 + (p.y - center.y),
    };
  };

  for (const z of zones) {
    const { x, y } = toPx(z.lat, z.lng);
    if (x < -40 || y < -40 || x > width + 40 || y > height + 40) continue;
    const color = ZONE_COLORS_CSS[z.zone || z.name] || ZONE_COLORS_CSS.UNSPECIFIED;

    // Pin shadow
    ctx.beginPath();
    ctx.ellipse(x, y + 2, 7, 3, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fill();

    // Pin body (teardrop-ish circle)
    ctx.beginPath();
    ctx.arc(x, y - 4, 9, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();

    // Count
    ctx.fillStyle = "#fff";
    ctx.font = "bold 10px Helvetica, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(z.count ?? ""), x, y - 4);
  }

  // Border
  ctx.strokeStyle = "#94a3b8";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, width - 2, height - 2);

  return canvas.toDataURL("image/png");
}

async function waitForMapTiles(leafletEl, maxMs = 4000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const imgs = leafletEl.querySelectorAll(".leaflet-tile-pane img.leaflet-tile");
      const ready =
        imgs.length > 0 &&
        [...imgs].every((img) => img.complete && img.naturalWidth > 0);
      if (ready || Date.now() - start > maxMs) resolve(ready);
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

/**
 * Composite Leaflet OSM tiles + zone pins onto a canvas (real map look for PDF).
 * Avoids html2canvas CORS/transform issues.
 */
export async function captureLeafletMap(mapWrapperEl, leafletMap, zones) {
  if (!mapWrapperEl) return null;
  const leaflet = mapWrapperEl.querySelector(".leaflet-container");
  if (!leaflet) return null;

  mapWrapperEl.classList.add("pdf-exporting");
  try {
    if (leafletMap && zones?.length) {
      const points = leafletBoundsFromZones(zones);
      if (points.length === 1) {
        leafletMap.setView(points[0], 4);
      } else if (points.length > 1) {
        leafletMap.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 5 });
      }
      leafletMap.invalidateSize();
      await new Promise((r) => setTimeout(r, 450));
    } else if (leafletMap) {
      leafletMap.invalidateSize();
      await new Promise((r) => setTimeout(r, 200));
    }

    const tilesReady = await waitForMapTiles(leaflet, 4500);
    const mapRect = leaflet.getBoundingClientRect();
    if (mapRect.width < 40 || mapRect.height < 40) return null;

    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(mapRect.width * scale));
    canvas.height = Math.max(1, Math.round(mapRect.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(scale, scale);
    ctx.fillStyle = "#aad3df";
    ctx.fillRect(0, 0, mapRect.width, mapRect.height);

    let tilesDrawn = 0;
    const tiles = leaflet.querySelectorAll(".leaflet-tile-pane img.leaflet-tile");
    for (const img of tiles) {
      if (!img.complete || img.naturalWidth === 0) continue;
      const r = img.getBoundingClientRect();
      const x = r.left - mapRect.left;
      const y = r.top - mapRect.top;
      try {
        ctx.drawImage(img, x, y, r.width, r.height);
        tilesDrawn += 1;
      } catch {
        /* cross-origin tile — skip */
      }
    }

    // If tile draw failed (CORS), fall back to html2canvas
    if (tilesDrawn === 0) {
      try {
        const shot = await html2canvas(leaflet, {
          scale: 2,
          useCORS: true,
          allowTaint: false,
          backgroundColor: "#aad3df",
          logging: false,
          ignoreElements: (node) =>
            node.classList?.contains("leaflet-control-container") ||
            node.classList?.contains("leaflet-tooltip-pane"),
        });
        // Still redraw pins on top for clarity
        const out = document.createElement("canvas");
        out.width = shot.width;
        out.height = shot.height;
        const octx = out.getContext("2d");
        octx.drawImage(shot, 0, 0);
        drawPinsOnCtx(octx, leafletMap, zones, shot.width / mapRect.width);
        return out.toDataURL("image/png");
      } catch (err) {
        console.warn("html2canvas map fallback failed:", err);
        if (!tilesReady) return null;
      }
    }

    drawPinsOnCtx(ctx, leafletMap, zones, 1);
    return canvas.toDataURL("image/png");
  } catch (err) {
    console.warn("Leaflet capture failed:", err);
    return null;
  } finally {
    mapWrapperEl.classList.remove("pdf-exporting");
  }
}

function drawPinsOnCtx(ctx, leafletMap, zones, cssToCanvas = 1) {
  if (!leafletMap || !zones?.length) return;
  const s = cssToCanvas || 1;
  for (const z of zones) {
    let pt;
    try {
      pt = leafletMap.latLngToContainerPoint([z.lat, z.lng]);
    } catch {
      continue;
    }
    const x = pt.x * s;
    const y = pt.y * s;
    const r = 8 * Math.min(Math.max(s, 1), 2);
    const color = ZONE_COLORS_CSS[z.zone || z.name] || ZONE_COLORS_CSS.UNSPECIFIED;

    ctx.beginPath();
    ctx.arc(x, y - 4 * s, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2 * Math.min(s, 2);
    ctx.strokeStyle = "#fff";
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.font = `bold ${10 * Math.min(s, 2)}px Helvetica, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(z.count ?? ""), x, y - 4 * s);
  }
}

async function resolveMapImage(zones, mapWrapperEl, leafletMap) {
  // Prefer the live Leaflet map (same as draft modal)
  try {
    const live = await captureLeafletMap(mapWrapperEl, leafletMap, zones);
    if (live) return live;
  } catch (err) {
    console.warn("Live map capture failed:", err);
  }
  // Fallback: drawn pin map (never blank)
  return renderZonesMapImage(zones);
}

function fitImageInBox(doc, imgData, x, y, maxW, maxH) {
  const props = doc.getImageProperties(imgData);
  const aspect = props.width / props.height;
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  doc.addImage(imgData, "PNG", x, y, w, h);
  return { w, h };
}

/** Compact legend row directly under the map (modal-style, minimal height). */
function drawLegendBelow(doc, zones, x, y, maxW) {
  const sorted = [...(zones || [])].sort((a, b) => {
    const ia = ZONE_ORDER.indexOf(a.zone || a.name);
    const ib = ZONE_ORDER.indexOf(b.zone || b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  if (!sorted.length) return 0;

  const rowH = 7;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(186, 230, 253);
  doc.setLineWidth(0.25);
  doc.roundedRect(x, y, maxW, rowH + 2, 1.5, 1.5, "FD");

  let cursorX = x + 3;
  const midY = y + rowH / 2 + 1.2;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(12, 74, 110);

  for (const z of sorted) {
    const label = `${z.name} (${z.count})`;
    const labelW = doc.getTextWidth(label);
    const chipW = 5 + labelW + 4;
    if (cursorX + chipW > x + maxW - 2) break;

    const rgb = ZONE_COLORS[z.zone || z.name] || ZONE_COLORS.UNSPECIFIED;
    doc.setFillColor(...rgb);
    doc.circle(cursorX + 2, midY - 1.2, 1.6, "F");
    doc.text(label, cursorX + 5, midY);
    cursorX += chipW + 3;
  }

  return rowH + 2;
}

function drawMapFrame(doc, x, y, w, h) {
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.3);
  doc.roundedRect(x, y, w, h, 2, 2, "S");
}

/**
 * Landscape PDF: map + legend under it + vessel tables.
 */
export async function downloadDraftPdf({
  vessels = [],
  columns = [],
  zones = [],
  mapWrapperEl = null,
  leafletMap = null,
  filename = "vessel-draft.pdf",
}) {
  if (!vessels.length || !columns.length) {
    throw new Error("Nothing to export");
  }

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 10;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(3, 105, 161);
  doc.text("Map & Draft", margin, y);
  y += 6;

  const contentW = pageW - margin * 2;
  // Compact map — leave room for table
  const maxMapH = 42;
  const maxMapW = contentW;

  if (zones?.length) {
    const mapImg = await resolveMapImage(zones, mapWrapperEl, leafletMap);
    let mapH = maxMapH;
    let mapW = maxMapW;

    if (mapImg) {
      const fitted = fitImageInBox(doc, mapImg, margin, y, maxMapW, maxMapH);
      drawMapFrame(doc, margin, y, fitted.w, fitted.h);
      mapH = fitted.h;
      mapW = fitted.w;
    } else {
      doc.setFillColor(186, 230, 253);
      doc.roundedRect(margin, y, maxMapW, maxMapH, 2, 2, "F");
      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text("Map unavailable", margin + 4, y + 8);
    }

    y += mapH + 2;
    const legendH = drawLegendBelow(doc, zones, margin, y, mapW);
    y += legendH + 5;
  }

  const byZone = groupVesselsByZone(vessels);
  const headers = columns.map((c) => c.header);
  let globalRowNum = 1;
  const zoneKeys = orderedZoneKeys(byZone);

  if (!zoneKeys.length && vessels.length) {
    zoneKeys.push("UNSPECIFIED");
    byZone.UNSPECIFIED = vessels;
  }

  for (const zone of zoneKeys) {
    const zoneVessels = byZone[zone];
    if (!zoneVessels?.length) continue;

    const label = `${zone} (${zoneVessels.length} vessel${zoneVessels.length !== 1 ? "s" : ""})`;

    if (y > pageH - 24) {
      doc.addPage();
      y = margin;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(12, 74, 110);
    doc.text(label, margin, y);
    y += 4;

    const body = zoneVessels.map((v) => {
      const rowNum = globalRowNum;
      globalRowNum += 1;
      return columns.map((c) => {
        const raw = resolveStandardCellValue(v, c.id, rowNum);
        return hasDisplayValue(raw) ? String(raw) : "—";
      });
    });

    autoTable(doc, {
      startY: y,
      head: [headers],
      body,
      theme: "grid",
      styles: {
        fontSize: 7,
        cellPadding: 1.4,
        overflow: "linebreak",
        textColor: [12, 74, 110],
        lineColor: [148, 163, 184],
        lineWidth: 0.1,
      },
      headStyles: {
        fillColor: [3, 105, 161],
        textColor: [255, 255, 255],
        fontStyle: "bold",
        halign: "left",
      },
      alternateRowStyles: { fillColor: [241, 245, 249] },
      margin: { left: margin, right: margin },
      tableWidth: pageW - margin * 2,
      horizontalPageBreak: false,
    });

    y = (doc.lastAutoTable?.finalY ?? y) + 6;
  }

  doc.save(filename);
}
