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
    <div className="draft-modal-bg" onClick={onClose}>
      <div className="draft-modal" onClick={(e) => e.stopPropagation()}>
        <div className="draft-modal-bar">
          <span>Map &amp; Draft Preview</span>
          <button
            type="button"
            onClick={onClose}
            className="draft-modal-close"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          <DraftView
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
