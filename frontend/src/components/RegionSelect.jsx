import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { REGION_OPTIONS } from "../utils/regionOptions";

/**
 * Editable region combobox: pick a standard region or type any value.
 * Same UX as vessel type — use only inside Edit / Add flows.
 */
export default function RegionSelect({ value, onChange, onCommit, fieldSize = false }) {
  const raw = String(value || "");
  const trimmed = raw.trim();
  const isListed = REGION_OPTIONS.includes(trimmed) && trimmed !== "Others";
  const options = [
    { value: "", label: "Select region…" },
    ...REGION_OPTIONS.map((opt) => ({ value: opt, label: opt })),
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
    const width = Math.max(r.width, 240);
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
      <div className={`vlib-type-combo ${open ? "open" : ""} ${trimmed ? "" : "is-empty"}`}>
        <input
          ref={inputRef}
          type="text"
          value={raw}
          placeholder="Select or type region…"
          title="Pick from list or type any region"
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
          aria-label="Open region list"
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
                  ? Boolean(trimmed) && !isListed
                  : opt.value === trimmed && isListed;
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
