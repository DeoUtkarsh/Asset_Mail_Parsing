import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import html2canvas from "html2canvas";
import L from "leaflet";
import { ZONE_ORDER } from "./zoneMapping";
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
  EUROPE: [59, 130, 246],
  AFRICA: [239, 68, 68],
  OCEANIA: [236, 72, 153],
  UNSPECIFIED: [148, 163, 184],
};

const STATIC_MAP_MARKER = {
  "STRAITS/SEA": "blue",
  "FAR EAST": "orange",
  INDIA: "green",
  "AG/MIDDLE EAST": "purple",
  EUROPE: "lightblue1",
  AFRICA: "red",
  OCEANIA: "pink",
  UNSPECIFIED: "gray",
};

function groupVesselsByZone(vessels) {
  const byZone = {};
  for (const v of vessels || []) {
    const zone = v.filename || v.attachment_id || "UNSPECIFIED";
    if (!byZone[zone]) byZone[zone] = [];
    byZone[zone].push(v);
  }
  return byZone;
}

function buildStaticMapUrl(zones) {
  const view = mapViewFromZones(zones);
  const markerStr = (zones || [])
    .map((z) => {
      const colour = STATIC_MAP_MARKER[z.name] || "gray";
      return `${z.lat},${z.lng},${colour}`;
    })
    .join("|");

  const params = new URLSearchParams({
    center: `${view.lat},${view.lng}`,
    zoom: String(view.zoom),
    size: `${view.size.w}x${view.size.h}`,
    maptype: "mapnik",
  });
  if (markerStr) params.set("markers", markerStr);
  return `https://staticmap.openstreetmap.de/staticmap.php?${params.toString()}`;
}

async function fetchStaticMapImage(zones) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(buildStaticMapUrl(zones), {
      mode: "cors",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Map fetch failed (${res.status})`);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.warn("Static map fetch failed:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForMapTiles(leafletEl, maxMs = 2500) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const imgs = leafletEl.querySelectorAll(".leaflet-tile-pane img");
      const ready =
        imgs.length > 0 &&
        [...imgs].every((img) => img.complete && img.naturalWidth > 0);
      if (ready || Date.now() - start > maxMs) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

/** Screenshot the live Leaflet map exactly as shown in the draft modal. */
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
      await new Promise((r) => setTimeout(r, 300));
    } else if (leafletMap) {
      leafletMap.invalidateSize();
      await new Promise((r) => setTimeout(r, 150));
    }
    await waitForMapTiles(leaflet);
    const canvas = await html2canvas(leaflet, {
      scale: 2,
      useCORS: true,
      allowTaint: false,
      backgroundColor: "#aad3df",
      logging: false,
      ignoreElements: (node) =>
        node.classList?.contains("leaflet-control-container") ||
        node.classList?.contains("leaflet-tooltip-pane"),
      onclone: (clonedDoc) => {
        clonedDoc.querySelectorAll(".leaflet-tooltip-pane").forEach((el) => {
          el.style.display = "none";
        });
      },
    });
    return canvas.toDataURL("image/png");
  } catch (err) {
    console.warn("Leaflet capture failed:", err);
    return null;
  } finally {
    mapWrapperEl.classList.remove("pdf-exporting");
  }
}

async function resolveMapImage(zones, mapWrapperEl, leafletMap) {
  const live = await captureLeafletMap(mapWrapperEl, leafletMap, zones);
  if (live) return live;
  return fetchStaticMapImage(zones);
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

function drawLegendBox(doc, zones, x, y, w, h) {
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(186, 230, 253);
  doc.setLineWidth(0.3);
  doc.roundedRect(x, y, w, h, 2, 2, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(3, 105, 161);
  doc.text("Zones", x + 4, y + 6);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(12, 74, 110);

  let legY = y + 12;
  const sorted = [...(zones || [])].sort((a, b) => {
    const ia = ZONE_ORDER.indexOf(a.name);
    const ib = ZONE_ORDER.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  for (const z of sorted) {
    const rgb = ZONE_COLORS[z.name] || ZONE_COLORS.UNSPECIFIED;
    doc.setFillColor(...rgb);
    doc.circle(x + 5, legY - 1.3, 2, "F");
    doc.text(`${z.name}`, x + 9, legY);
    doc.setFont("helvetica", "bold");
    doc.text(`(${z.count})`, x + w - 4, legY, { align: "right" });
    doc.setFont("helvetica", "normal");
    legY += 6.5;
  }
}

function drawMapFrame(doc, x, y, w, h) {
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.3);
  doc.roundedRect(x, y, w, h, 2, 2, "S");
}

/**
 * Landscape PDF: OSM map fitted to zone markers + legend + tables.
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
  doc.setFontSize(14);
  doc.setTextColor(3, 105, 161);
  doc.text("Map & Draft", margin, y);
  y += 8;

  const maxMapH = 68;
  const maxMapW = pageW * 0.74;
  const legendW = pageW - margin * 2 - maxMapW - 4;
  const legendX = margin + maxMapW + 4;

  if (zones?.length) {
    const mapImg = await resolveMapImage(zones, mapWrapperEl, leafletMap);
    let mapBlockH = maxMapH;

    if (mapImg) {
      const { w, h } = fitImageInBox(doc, mapImg, margin, y, maxMapW, maxMapH);
      drawMapFrame(doc, margin, y, w, h);
      mapBlockH = h;
    } else {
      doc.setFillColor(186, 230, 253);
      doc.roundedRect(margin, y, maxMapW, maxMapH, 2, 2, "F");
      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text("Map unavailable — check network and retry", margin + 4, y + 8);
    }

    drawLegendBox(doc, zones, legendX, y, legendW, mapBlockH);
    y += mapBlockH + 8;
  }

  const byZone = groupVesselsByZone(vessels);
  const headers = columns.map((c) => c.header);
  let globalRowNum = 1;

  for (const zone of ZONE_ORDER) {
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
