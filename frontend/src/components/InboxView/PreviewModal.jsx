import { useEffect } from "react";
import PreviewPanel from "./PreviewPanel";

/**
 * Overlay wrapper around the inline PreviewPanel.
 * Used where a popup is still desired (e.g. the Review tab detail view).
 */
export default function PreviewModal({ onClose, ...panelProps }) {
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="ipreview-modal-bg"
      onClick={(e) => e.target.classList.contains("ipreview-modal-bg") && onClose?.()}
    >
      <div className="ipreview-modal">
        <PreviewPanel {...panelProps} onClose={onClose} />
      </div>
    </div>
  );
}
