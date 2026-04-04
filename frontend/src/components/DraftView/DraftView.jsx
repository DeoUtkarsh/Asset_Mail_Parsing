import { useState, useEffect, useRef } from "react";
import { MapContainer, TileLayer, Marker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Zone accent colours (same order as backend ZONE_ORDER)
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
    <div
      style={{ position: "absolute", bottom: 10, right: 10, zIndex: 1000 }}
    >
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

export default function DraftView({ html = "", zones = [] }) {
  const [copied, setCopied] = useState(false);
  const iframeRef = useRef(null);

  // Reset copied state when new draft arrives
  useEffect(() => { setCopied(false); }, [html]);

  const handleCopy = () => {
    // Copy plain-text version by extracting text from the HTML
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const text = tmp.innerText || tmp.textContent || html;
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const wordCount = html
    ? (html.replace(/<[^>]*>/g, " ").match(/\S+/g) || []).length
    : 0;

  const hasContent = Boolean(html);

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: "#f0f9ff" }}>

      {/* ── Header — ocean gradient ── */}
      <div
        className="flex items-center justify-between px-6 py-4 flex-shrink-0 shadow-md"
        style={{ background: "linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%)" }}
      >
        <div>
          <h2 className="text-base font-bold text-white tracking-wide">⚓ Generated Draft</h2>
          <p className="text-xs mt-0.5" style={{ color: "#bae6fd" }}>
            {hasContent
              ? `Consolidated position list · ${wordCount} words · ${zones.length} zone${zones.length !== 1 ? "s" : ""}`
              : "Review the final email below, then copy into your email client."}
          </p>
        </div>
        <button
          onClick={handleCopy}
          disabled={!hasContent}
          className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
          style={copied
            ? { background: "#6ee7b7", color: "#064e3b", border: "none" }
            : { background: "#fff", color: "#0c4a6e", border: "none" }
          }
          onMouseEnter={e => { if (!copied && hasContent) e.currentTarget.style.background = "#e0f2fe"; }}
          onMouseLeave={e => { if (!copied) e.currentTarget.style.background = "#fff"; }}
        >
          {copied ? "✔ Copied!" : "⎘ Copy to Clipboard"}
        </button>
      </div>

      {!hasContent ? (
        /* ── Empty state ── */
        <div
          className="flex-1 flex flex-col items-center justify-center gap-4 rounded-xl border-dashed m-6"
          style={{ background: "#fff", border: "2px dashed #bae6fd" }}
        >
          <div className="text-5xl" style={{ color: "#bae6fd" }}>✉</div>
          <p className="text-sm text-center max-w-sm" style={{ color: "#7dd3fc" }}>
            No draft yet. Go to{" "}
            <span className="font-semibold" style={{ color: "#0369a1" }}>② Validate</span>, review
            your vessels, and click{" "}
            <span className="font-semibold" style={{ color: "#0369a1" }}>Generate Draft</span>.
          </p>
        </div>
      ) : (
        /* ── Content: map left, email right ── */
        <div className="flex-1 min-h-0 flex flex-row gap-4 p-4 overflow-hidden">

          {/* ── Left: map + legend ── */}
          <div className="flex flex-col gap-3 flex-shrink-0 min-h-0" style={{ width: "30%" }}>
            {zones.length > 0 && (
              <>
                <div
                  className="flex-1 min-h-0 rounded-xl overflow-hidden shadow-md"
                  style={{ border: "1px solid #bae6fd" }}
                >
                  <ZoneMap zones={zones} />
                </div>
                {/* Zone legend — pinned at bottom */}
                <div
                  className="flex flex-col gap-1.5 px-3 py-2 rounded-xl flex-shrink-0"
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
              </>
            )}
          </div>

          {/* ── Right: email preview ── */}
          <div className="flex-1 min-h-0 flex flex-col gap-1 overflow-hidden">
            <iframe
              ref={iframeRef}
              srcDoc={html}
              title="Draft email preview"
              sandbox="allow-same-origin"
              className="flex-1 min-h-0 w-full rounded-xl shadow-md bg-white"
              style={{ border: "1px solid #bae6fd" }}
            />
            <p className="text-xs text-right flex-shrink-0" style={{ color: "#7dd3fc" }}>
              Read-only preview — use "Copy to Clipboard" to send via your email client.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
