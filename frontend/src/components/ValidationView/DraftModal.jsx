import { useEffect } from "react";
import { createPortal } from "react-dom";
import DraftView from "../DraftView/DraftView";

export default function DraftModal({ open, onClose, html, zones, vessels, columns }) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(12, 74, 110, 0.55)" }}
    >
      <div
        className="relative w-[95vw] h-[90vh] rounded-2xl shadow-2xl flex flex-col min-h-0 overflow-hidden"
        style={{ background: "#f0f9ff", border: "1px solid #bae6fd" }}
      >
        <div
          className="flex items-center justify-between px-5 py-2 flex-shrink-0"
          style={{ background: "#e0f2fe", borderBottom: "1px solid #bae6fd" }}
        >
          <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "#0369a1" }}>
            Map &amp; Draft Preview
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-lg leading-none font-bold transition-colors"
            style={{ color: "#0369a1" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#bae6fd"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          <DraftView
            embedded
            title="Map & Draft"
            html={html}
            zones={zones}
            vessels={vessels}
            columns={columns}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
