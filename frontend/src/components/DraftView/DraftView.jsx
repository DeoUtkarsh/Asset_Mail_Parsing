import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import EditableGrid from "../ValidationView/EditableGrid";
import { regionToZone } from "../../utils/zoneMapping";
import { leafletBoundsFromZones } from "../../utils/mapBounds";
import { getColumnDefinitions } from "../../services/api";
import { DEFAULT_COLUMNS } from "../../utils/standardColumns";
import { copyEmailHtml } from "../../utils/copyEmailHtml";
import { downloadDraftPdf } from "../../utils/downloadDraftPdf";

// Zone accent colours (same order as backend ZONE_ORDER)
const ZONE_COLORS = {
  "STRAITS/SEA":    "#0ea5e9",
  "FAR EAST":       "#f59e0b",
  "INDIA":          "#10b981",
  "AG/MIDDLE EAST": "#8b5cf6",
  "MED/BLACK SEA":  "#14b8a6",
  "EUROPE":         "#3b82f6",
  "AFRICA":         "#ef4444",
  "AMERICAS":       "#f97316",
  "OCEANIA":        "#ec4899",
  "UNSPECIFIED":    "#94a3b8",
};

function makePinIcon(count, color) {
  const html = `
    <div style="position:relative;width:18px;height:24px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.35))">
      <div style="
        width:18px;height:18px;
        background:${color};
        border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        border:2px solid #fff;
      "></div>
      <span style="
        position:absolute;top:1px;left:0;width:18px;
        text-align:center;color:#fff;
        font-size:8px;font-weight:700;line-height:15px;
        font-family:Arial,sans-serif;
      ">${count}</span>
    </div>`;
  return L.divIcon({
    className: "",
    html,
    iconSize: [18, 24],
    iconAnchor: [9, 24],
    tooltipAnchor: [0, -20],
  });
}

function FitZoneBounds({ zones }) {
  const map = useMap();
  useEffect(() => {
    const points = leafletBoundsFromZones(zones);
    if (!points?.length) return;
    if (points.length === 1) {
      map.setView(points[0], 4);
      return;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 5 });
  }, [map, zones]);
  return null;
}

function RecenterControl({ zones }) {
  const map = useMap();
  return (
    <div style={{ position: "absolute", bottom: 10, right: 10, zIndex: 1000 }}>
      <button
        type="button"
        onClick={() => {
          const points = leafletBoundsFromZones(zones);
          if (!points?.length) return;
          if (points.length === 1) {
            map.setView(points[0], 4);
            return;
          }
          map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 5 });
        }}
        title="Fit all zone markers"
        style={{
          background: "#fff",
          border: "2px solid rgba(0,0,0,0.2)",
          borderRadius: 4,
          width: 30,
          height: 30,
          fontSize: 16,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 1px 5px rgba(0,0,0,0.2)",
        }}
      >
        ⌖
      </button>
    </div>
  );
}

function MapCaptureBridge({ onMapReady }) {
  const map = useMap();
  useEffect(() => {
    onMapReady?.(map);
    return () => onMapReady?.(null);
  }, [map, onMapReady]);
  return null;
}

function ZoneMap({ zones, onMapReady }) {
  if (!zones || zones.length === 0) return null;

  return (
    <MapContainer
      center={[15, 100]}
      zoom={3}
      minZoom={2}
      maxZoom={8}
      scrollWheelZoom={true}
      style={{ height: "100%", width: "100%", borderRadius: "0.75rem" }}
      attributionControl={false}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="© OpenStreetMap contributors"
        crossOrigin="anonymous"
      />
      <FitZoneBounds zones={zones} />
      <MapCaptureBridge onMapReady={onMapReady} />
      <RecenterControl zones={zones} />
      {zones.map((z) => (
        <Marker
          key={`${z.name}-${z.lat}-${z.lng}`}
          position={[z.lat, z.lng]}
          icon={makePinIcon(z.count, ZONE_COLORS[z.zone || z.name] || "#94a3b8")}
        >
          <Tooltip direction="top" offset={[0, -4]}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>
              {z.name} — {z.count} vessel{z.count !== 1 ? "s" : ""}
            </span>
          </Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}

export default function DraftView({ html = "", zones = [], vessels = [], columns = [] }) {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [mapOpen, setMapOpen] = useState(false); // collapsed by default
  const [columnDefs, setColumnDefs] = useState(DEFAULT_COLUMNS);
  const mapWrapperRef = useRef(null);
  const leafletMapRef = useRef(null);
  const onMapReady = useCallback((map) => { leafletMapRef.current = map; }, []);

  useEffect(() => {
    getColumnDefinitions()
      .then((r) => setColumnDefs(r.columns?.length ? r.columns : DEFAULT_COLUMNS))
      .catch(() => setColumnDefs(DEFAULT_COLUMNS));
  }, []);

  useEffect(() => { setCopied(false); }, [html, vessels]);

  // Flat list — no region/zone grouping headers.
  const gridVessels = useMemo(() => {
    const list = [...(vessels || [])];
    list.sort((a, b) =>
      String(a?.dynamic_data?.vessel_name || "").localeCompare(
        String(b?.dynamic_data?.vessel_name || ""),
      ),
    );
    return list;
  }, [vessels]);

  const gridColumns = useMemo(() => {
    if (!columns?.length) return columnDefs;
    const allowed = new Set(columns);
    return columnDefs.filter((c) => allowed.has(c.id));
  }, [columnDefs, columns]);

  const zoneCount = useMemo(
    () => new Set(vessels.map((v) => regionToZone(v.region))).size,
    [vessels],
  );

  const hasGrid = vessels.length > 0;
  const hasContent = hasGrid || Boolean(html);
  const showPdfDownload = gridColumns.length > 9;

  const handleCopy = async () => {
    try {
      await copyEmailHtml(html, { vessels: gridVessels, columns: gridColumns });
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Copy failed:", e);
      alert("Could not copy to clipboard. Try again or use Ctrl+V in your email compose window.");
    }
  };

  const handleDownloadPdf = async () => {
    setDownloading(true);
    const wasMapOpen = mapOpen;
    try {
      // Map must be mounted + tiles loaded for a real PDF map (collapsed = no Leaflet DOM)
      if (zones.length > 0 && !mapOpen) {
        setMapOpen(true);
        await new Promise((r) => setTimeout(r, 200));
      }
      // Wait until Leaflet instance exists and has size
      for (let i = 0; i < 40; i++) {
        const map = leafletMapRef.current;
        const wrap = mapWrapperRef.current;
        const el = wrap?.querySelector(".leaflet-container");
        if (map && el && el.getBoundingClientRect().width > 40) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (leafletMapRef.current) {
        leafletMapRef.current.invalidateSize();
        await new Promise((r) => setTimeout(r, 500));
      }

      const stamp = new Date().toISOString().slice(0, 10);
      await downloadDraftPdf({
        vessels: gridVessels,
        columns: gridColumns,
        zones,
        mapWrapperEl: mapWrapperRef.current,
        leafletMap: leafletMapRef.current,
        filename: `vessel-draft-${stamp}.pdf`,
      });
    } catch (e) {
      console.error("PDF download failed:", e);
      alert("Could not generate PDF. Try again or use Copy to Clipboard.");
    } finally {
      if (!wasMapOpen) setMapOpen(false);
      setDownloading(false);
    }
  };

  return (
    <div className="draft-root">
      <div className="draft-head">
        <div className="draft-head-left">
          <div className="draft-head-title">
            <h2>Generated Draft</h2>
            <p className="draft-sub">
              {hasContent
                ? "Consolidated position list"
                : "Review the final email below, then copy into your email client."}
            </p>
          </div>

          {hasGrid && (
            <div className="draft-stats" aria-label="Draft summary">
              <div className="draft-stat"><span>Vessels</span> <b>{vessels.length}</b></div>
              <div className="draft-stat"><span>Zones</span> <b>{zoneCount}</b></div>
              <div className="draft-stat"><span>Columns</span> <b>{gridColumns.length}</b></div>
            </div>
          )}
        </div>

        <div className="draft-actions">
          {showPdfDownload && (
            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={!hasGrid || downloading}
              className="draft-btn"
            >
              {downloading ? "Generating…" : "⬇ Download PDF"}
            </button>
          )}
          <button
            onClick={handleCopy}
            disabled={!hasGrid && !html}
            className={`draft-btn primary ${copied ? "copied" : ""}`}
          >
            {copied ? "✔ Copied!" : "⎘ Copy to Clipboard"}
          </button>
        </div>
      </div>

      {!hasContent ? (
        <div className="draft-empty">
          <div className="draft-empty-ic" aria-hidden>✉</div>
          <p style={{ maxWidth: "22rem" }}>
            No draft yet. Go to <b>Vessel Position List</b>, select your vessels, and click{" "}
            <b>Generate Draft</b>.
          </p>
        </div>
      ) : hasGrid ? (
        <div className="draft-body draft-body-stack">
          {zones.length > 0 && (
            <div className={`draft-map-panel ${mapOpen ? "is-open" : "is-collapsed"}`}>
              <button
                type="button"
                className="draft-map-toggle"
                onClick={() => setMapOpen((v) => !v)}
                aria-expanded={mapOpen}
              >
                <span>{mapOpen ? "▾" : "▸"} Map</span>
                <span className="draft-map-toggle-meta">
                  {zones.length} zone{zones.length !== 1 ? "s" : ""}
                </span>
              </button>
              {mapOpen && (
                <div className="draft-map-panel-body">
                  <div ref={mapWrapperRef} className="draft-map draft-map-capture">
                    <ZoneMap zones={zones} onMapReady={onMapReady} />
                  </div>
                  <div className="draft-legend draft-legend-h">
                    {zones.map((z) => (
                      <div key={`${z.name}-${z.lat}-${z.lng}`} className="draft-legend-row">
                        <span
                          className="draft-legend-dot"
                          style={{ background: ZONE_COLORS[z.zone || z.name] || "#94a3b8" }}
                        />
                        <span>{z.name}</span>
                        <b>({z.count})</b>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="draft-right">
            <EditableGrid
              data={gridVessels}
              gridColumns={gridColumns}
              onCellEdit={() => {}}
              readOnly
              showCheckboxes={false}
              hideGroupHeaders
              groupHeaderIcon={null}
            />
            <p className="draft-note">
              Copy uses the same columns as this grid.
              {showPdfDownload ? " Download PDF (10+ columns) exports map + full table in one flow." : ""}
            </p>
          </div>
        </div>
      ) : (
        <div className="draft-body" style={{ flexDirection: "column" }}>
          <iframe
            srcDoc={html}
            title="Draft email preview"
            sandbox="allow-same-origin"
            className="draft-iframe"
          />
          <p className="draft-note">
            Read-only preview — use "Copy to Clipboard" to send via your email client.
          </p>
        </div>
      )}
    </div>
  );
}
