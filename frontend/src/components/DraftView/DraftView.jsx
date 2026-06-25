import { useState, useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import EditableGrid from "../ValidationView/EditableGrid";
import { regionToZone, vesselsGroupedByZone } from "../../utils/zoneMapping";
import { STANDARD_COLUMN_IDS } from "../../utils/standardColumns";
import { copyEmailHtml } from "../../utils/copyEmailHtml";

const ZONE_COLORS = {
  "STRAITS/SEA":    "#0ea5e9",
  "FAR EAST":       "#f59e0b",
  "INDIA":          "#10b981",
  "AG/MIDDLE EAST": "#8b5cf6",
  "EUROPE":         "#3b82f6",
  "AFRICA":         "#ef4444",
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

function RecenterControl() {
  const map = useMap();
  return (
    <div style={{ position: "absolute", bottom: 10, right: 10, zIndex: 1000 }}>
      <button
        onClick={() => map.setView([15, 100], 3)}
        title="Reset view"
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

function ZoneMap({ zones }) {
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
      />
      <RecenterControl />
      {zones.map((z) => (
        <Marker
          key={z.name}
          position={[z.lat, z.lng]}
          icon={makePinIcon(z.count, ZONE_COLORS[z.name] || "#94a3b8")}
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

  useEffect(() => { setCopied(false); }, [html, vessels]);

  const gridVessels = useMemo(() => vesselsGroupedByZone(vessels), [vessels]);

  const zoneCount = useMemo(
    () => new Set(vessels.map((v) => regionToZone(v.region))).size,
    [vessels]
  );

  const hasGrid = vessels.length > 0;
  const hasContent = hasGrid || Boolean(html);

  const handleCopy = async () => {
    try {
      await copyEmailHtml(html, { vessels: gridVessels });
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Copy failed:", e);
      alert("Could not copy to clipboard. Try again or use Ctrl+V in your email compose window.");
    }
  };

  return (
    <div className="flex flex-col h-full gap-0" style={{ background: "#f0f9ff" }}>

      <div
        className="flex items-center justify-between px-6 py-4 flex-shrink-0 shadow-md"
        style={{ background: "linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%)" }}
      >
        <div>
          <h2 className="text-base font-bold text-white tracking-wide">Contact List</h2>
        </div>

        <button
          onClick={handleCopy}
          disabled={!hasGrid && !html}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium transition-all shadow-sm disabled:opacity-40 disabled:cursor-not-allowed ${
            copied
              ? ""
              : "bg-sky-600 text-white hover:bg-sky-700 disabled:hover:bg-sky-600"
          }`}
          style={copied ? { background: "#6ee7b7", color: "#064e3b" } : undefined}
        >
          {copied ? "Copied!" : "Copy to Clipboard"}
        </button>
      </div>

      {!hasContent ? (
        <div
          className="flex-1 flex flex-col items-center justify-center gap-4 rounded-xl border-dashed m-6"
          style={{ background: "#fff", border: "2px dashed #bae6fd" }}
        >
          <div className="text-5xl" style={{ color: "#bae6fd" }}>✉</div>
          <p className="text-sm text-center max-w-sm" style={{ color: "#7dd3fc" }}>
            No contact list yet. Go to{" "}
            <span className="font-semibold" style={{ color: "#0369a1" }}>Vessel Position List</span>, select
            vessels, and click{" "}
            <span className="font-semibold" style={{ color: "#0369a1" }}>Generate Draft</span>.
          </p>
        </div>
      ) : hasGrid ? (
        <>
          <div className="flex gap-2 px-4 py-2 flex-shrink-0" style={{ background: "#e0f2fe", borderBottom: "1px solid #bae6fd" }}>
            <Stat label="Vessels" value={vessels.length} />
            <Stat label="Zones" value={zoneCount} />
            <Stat label="Columns" value={STANDARD_COLUMN_IDS.length} />
          </div>

          <div className="flex-1 min-h-0 flex flex-row gap-3 p-3 overflow-hidden">

            {/* ── Left: zone map + legend ── */}
            {zones.length > 0 && (
              <div className="flex flex-col gap-2 flex-shrink-0 min-h-0" style={{ width: "28%" }}>
                <div
                  className="flex-1 min-h-0 rounded-lg overflow-hidden shadow-sm"
                  style={{ border: "1px solid #94a3b8" }}
                >
                  <ZoneMap zones={zones} />
                </div>
                <div
                  className="flex flex-col gap-1.5 px-3 py-2 rounded-lg flex-shrink-0"
                  style={{ background: "#fff", border: "1px solid #bae6fd" }}
                >
                  {zones.map((z) => (
                    <div key={z.name} className="flex items-center gap-2">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ background: ZONE_COLORS[z.name] || "#94a3b8" }}
                      />
                      <span className="text-xs" style={{ color: "#0369a1" }}>{z.name}</span>
                      <span className="text-xs font-bold ml-auto" style={{ color: "#0c4a6e" }}>({z.count})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Right: grid table (unchanged) ── */}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <EditableGrid
                data={gridVessels}
                columns={STANDARD_COLUMN_IDS}
                onCellEdit={() => {}}
                readOnly
                showCheckboxes={false}
                groupHeaderIcon={null}
              />
              <p className="text-[10px] text-right pt-1 flex-shrink-0" style={{ color: "#7dd3fc" }}>
                Copy to Clipboard pastes intro text + standard vessel columns into Gmail/Outlook.
              </p>
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 min-h-0 p-4 flex flex-col gap-2">
          <iframe
            srcDoc={html}
            title="Contact list preview"
            sandbox="allow-same-origin"
            className="flex-1 min-h-0 w-full rounded-lg shadow-sm bg-white"
            style={{ border: "1px solid #94a3b8" }}
          />
          <p className="text-[10px] text-right flex-shrink-0" style={{ color: "#7dd3fc" }}>
            Regenerate draft to see the updated grid view.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="px-2 py-1 rounded-md text-[11px] shadow-sm"
      style={{ background: "#fff", border: "1px solid #bae6fd" }}>
      <span style={{ color: "#7dd3fc" }}>{label}: </span>
      <span className="font-bold" style={{ color: "#0369a1" }}>{value}</span>
    </div>
  );
}
