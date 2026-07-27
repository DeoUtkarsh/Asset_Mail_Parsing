import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

export const VESSEL_TYPE_OPTIONS = [
  "Oil Tanker",
  "Chemical Tanker",
  "Bulk Carrier",
  "Chem/Prod Tanker",
  "Container",
  "LPG Carrier (Refri)",
  "LNG Carrier",
  "Cement Carrier",
  "Asphalt / Bitumen Tanker",
  "LPG Carrier (Press)",
  "Gen Cargo / Multi-Purpose Vessel",
  "Dredger",
  "Offshore Support Vessel",
  "Tug Boat",
  "Others",
];

export function isImoTypeValue(val) {
  const s = String(val || "").trim();
  if (!s) return false;
  return /^\d+(\/\d+)?$/i.test(s) || /^imo\s*[ivx\d]/i.test(s);
}

export function normalizeVesselType(val) {
  const raw = String(val || "").trim();
  if (!raw || isImoTypeValue(raw)) return "";
  return raw;
}

/**
 * Editable vessel-type combobox: pick a standard type or type any value.
 * Same UX in Vessel Library modals and Position / Extraction / Review grids.
 */
export default function VesselTypeSelect({ value, onChange, onCommit, fieldSize = false }) {
  const raw = String(value || "");
  const current = normalizeVesselType(raw);
  const isListed = VESSEL_TYPE_OPTIONS.includes(current);
  const options = [
    { value: "", label: "Select type…" },
    ...VESSEL_TYPE_OPTIONS.map((opt) => ({ value: opt, label: opt })),
  ];

  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 220 });

  const placeMenu = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 220);
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    const below = r.bottom + 4;
    const menuH = Math.min(280, options.length * 34 + 12);
    const top =
      below + menuH > window.innerHeight - 8
        ? Math.max(8, r.top - menuH - 4)
        : below;
    setMenuPos({ top, left, width });
  }, [options.length]);

  useEffect(() => {
    if (!open) return undefined;
    placeMenu();
    const onDoc = (e) => {
      if (wrapRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => placeMenu();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, placeMenu]);

  const pick = (optValue) => {
    setOpen(false);
    if (optValue === "Others") {
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.select();
      });
      return;
    }
    onChange(optValue);
    onCommit?.(optValue);
  };

  return (
    <div className={`vlib-type-dd ${fieldSize ? "vlib-type-dd--field" : ""}`} ref={wrapRef}>
      <div className={`vlib-type-combo ${open ? "open" : ""} ${raw.trim() ? "" : "is-empty"}`}>
        <input
          ref={inputRef}
          type="text"
          value={raw}
          placeholder="Select or type vessel type…"
          title="Pick from list or type any vessel type"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            const next = String(inputRef.current?.value || "").trim();
            if (next !== raw) onChange(next);
            onCommit?.(next);
          }}
          onFocus={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const next = String(inputRef.current?.value || "").trim();
              if (next !== raw) onChange(next);
              onCommit?.(next);
              setOpen(false);
            }
          }}
        />
        <button
          type="button"
          className="vlib-type-chev-btn"
          aria-label="Open vessel type list"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? "▲" : "▼"}
        </button>
      </div>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="vlib-type-menu"
            style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
            role="listbox"
          >
            {options.map((opt) => {
              const selected =
                opt.value === "Others"
                  ? Boolean(current) && !isListed
                  : opt.value === current && isListed;
              return (
                <button
                  key={opt.value || "__empty"}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={[
                    "vlib-type-opt",
                    selected ? "active" : "",
                    !opt.value ? "placeholder" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    pick(opt.value);
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}
