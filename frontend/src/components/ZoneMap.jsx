import { MapContainer, TileLayer, Marker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export const ZONE_COLORS = {
  "STRAITS/SEA": "#0ea5e9",
  "FAR EAST": "#f59e0b",
  "INDIA": "#10b981",
  "AG/MIDDLE EAST": "#8b5cf6",
  "EUROPE": "#3b82f6",
  "AFRICA": "#ef4444",
  "OCEANIA": "#ec4899",
  "UNSPECIFIED": "#94a3b8",
};

function makePinIcon(count, color) {
  const html = `
    <div style="position:relative;width:18px;height:24px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.35))">
      <div style="width:18px;height:18px;background:${color};border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid #fff;"></div>
      <span style="position:absolute;top:1px;left:0;width:18px;text-align:center;color:#fff;font-size:8px;font-weight:700;line-height:15px;font-family:Arial,sans-serif;">${count}</span>
    </div>`;
  return L.divIcon({ className: "", html, iconSize: [18, 24], iconAnchor: [9, 24], tooltipAnchor: [0, -20] });
}

function RecenterControl() {
  const map = useMap();
  return (
    <div style={{ position: "absolute", bottom: 10, right: 10, zIndex: 1000 }}>
      <button
        onClick={() => map.setView([15, 100], 3)}
        title="Reset view"
        style={{ background: "#fff", border: "2px solid rgba(0,0,0,0.2)", borderRadius: 4, width: 30, height: 30, fontSize: 16, cursor: "pointer" }}
      >⌖</button>
    </div>
  );
}

export default function ZoneMap({ zones }) {
  if (!zones || zones.length === 0) return null;
  return (
    <MapContainer center={[15, 100]} zoom={3} minZoom={2} maxZoom={8} scrollWheelZoom
      style={{ height: "100%", width: "100%" }} attributionControl={false}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap contributors" />
      <RecenterControl />
      {zones.map((z) => (
        <Marker key={z.name} position={[z.lat, z.lng]} icon={makePinIcon(z.count, ZONE_COLORS[z.name] || "#94a3b8")}>
          <Tooltip direction="top" offset={[0, -4]}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>{z.name} — {z.count} vessel{z.count !== 1 ? "s" : ""}</span>
          </Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
