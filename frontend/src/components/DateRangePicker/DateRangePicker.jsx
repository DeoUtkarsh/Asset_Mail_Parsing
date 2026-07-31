import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "../icons";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const POP_W = 568;
const POP_H = 380;
const GAP = 8;

function pad(n) {
  return String(n).padStart(2, "0");
}

function toKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseKey(key) {
  if (!key) return null;
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function sameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function inRange(day, from, to) {
  if (!from || !to) return false;
  const t = day.getTime();
  const a = Math.min(from.getTime(), to.getTime());
  const b = Math.max(from.getTime(), to.getTime());
  return t > a && t < b;
}

function formatDisplay(from, to) {
  const fmt = (key) => {
    const d = parseKey(key);
    if (!d) return "";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };
  if (from && to) return `${fmt(from)} – ${fmt(to)}`;
  if (from) return `${fmt(from)} – …`;
  if (to) return `… – ${fmt(to)}`;
  return "Select date range";
}

function buildMonthCells(monthDate) {
  const first = startOfMonth(monthDate);
  const startPad = first.getDay();
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startPad; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(first.getFullYear(), first.getMonth(), day));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  while (cells.length < 42) cells.push(null);
  return cells;
}

function placePopover(triggerEl) {
  if (!triggerEl) return { top: 80, left: 80 };
  const r = triggerEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(POP_W, vw - 24);
  let left = r.left;
  if (left + width > vw - 12) left = Math.max(12, vw - width - 12);
  if (left < 12) left = 12;

  let top = r.bottom + GAP;
  if (top + POP_H > vh - 12) {
    const above = r.top - GAP - POP_H;
    top = above >= 12 ? above : Math.max(12, vh - POP_H - 12);
  }
  return { top, left, width };
}

function MonthGrid({ monthDate, draftFrom, draftTo, onPick }) {
  const cells = useMemo(() => buildMonthCells(monthDate), [monthDate]);
  const title = `${MONTHS[monthDate.getMonth()]} ${monthDate.getFullYear()}`;

  return (
    <div className="drp-month">
      <div className="drp-month-title">{title}</div>
      <div className="drp-weekdays">
        {WEEKDAYS.map((d) => <span key={d}>{d}</span>)}
      </div>
      <div className="drp-days">
        {cells.map((day, idx) => {
          if (!day) return <span key={`e-${idx}`} className="drp-day empty" />;
          const isStart = sameDay(day, draftFrom);
          const isEnd = sameDay(day, draftTo);
          const isSingle = isStart && isEnd;
          const isIn = inRange(day, draftFrom, draftTo);
          const cls = [
            "drp-day",
            isStart || isEnd ? "edge" : "",
            isStart && !isSingle ? "start" : "",
            isEnd && !isSingle ? "end" : "",
            isSingle ? "single" : "",
            isIn ? "in-range" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              key={toKey(day)}
              type="button"
              className={cls}
              onClick={() => onPick(day)}
            >
              <span>{day.getDate()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Figma-style dual-month date range picker.
 * Popover is portaled to document.body so parent overflow cannot clip it.
 */
export default function DateRangePicker({
  from = "",
  to = "",
  onChange,
  applyMode = true,
  className = "",
  label,
}) {
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const popRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: POP_W });
  const [draftFrom, setDraftFrom] = useState(parseKey(from));
  const [draftTo, setDraftTo] = useState(parseKey(to));
  const [leftMonth, setLeftMonth] = useState(() => startOfMonth(parseKey(from) || new Date()));

  const rightMonth = useMemo(() => addMonths(leftMonth, 1), [leftMonth]);

  const updatePos = () => {
    setPos(placePopover(triggerRef.current));
  };

  useEffect(() => {
    if (!open) return;
    setDraftFrom(parseKey(from));
    setDraftTo(parseKey(to));
    setLeftMonth(startOfMonth(parseKey(from) || parseKey(to) || new Date()));
  }, [open, from, to]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePos();
    const onWin = () => updatePos();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      const t = e.target;
      if (rootRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (day) => {
    if (!draftFrom || (draftFrom && draftTo)) {
      setDraftFrom(day);
      setDraftTo(null);
      if (!applyMode) onChange?.({ from: toKey(day), to: "" });
      return;
    }
    let nextFrom = draftFrom;
    let nextTo = day;
    if (day.getTime() < draftFrom.getTime()) {
      nextFrom = day;
      nextTo = draftFrom;
    }
    setDraftFrom(nextFrom);
    setDraftTo(nextTo);
    if (!applyMode) onChange?.({ from: toKey(nextFrom), to: toKey(nextTo) });
  };

  const apply = () => {
    onChange?.({
      from: draftFrom ? toKey(draftFrom) : "",
      to: draftTo ? toKey(draftTo) : (draftFrom ? toKey(draftFrom) : ""),
    });
    setOpen(false);
  };

  const clear = () => {
    setDraftFrom(null);
    setDraftTo(null);
    onChange?.({ from: "", to: "" });
    setOpen(false);
  };

  const cancel = () => {
    setDraftFrom(parseKey(from));
    setDraftTo(parseKey(to));
    setOpen(false);
  };

  const popover = open
    ? createPortal(
      <div
        ref={popRef}
        className="drp-pop"
        role="dialog"
        aria-label="Date range"
        style={{ top: pos.top, left: pos.left, width: pos.width }}
      >
        <div className="drp-months">
          <div className="drp-nav-row">
            <button type="button" className="drp-nav" aria-label="Previous month" onClick={() => setLeftMonth((m) => addMonths(m, -1))}>
              <Icon name="chevronLeft" size={16} />
            </button>
            <span className="drp-nav-spacer" />
            <button type="button" className="drp-nav" aria-label="Next month" onClick={() => setLeftMonth((m) => addMonths(m, 1))}>
              <Icon name="chevronRight" size={16} />
            </button>
          </div>
          <div className="drp-months-grid">
            <MonthGrid monthDate={leftMonth} draftFrom={draftFrom} draftTo={draftTo} onPick={pick} />
            <div className="drp-divider" />
            <MonthGrid monthDate={rightMonth} draftFrom={draftFrom} draftTo={draftTo} onPick={pick} />
          </div>
        </div>
        <div className="drp-footer">
          <button type="button" className="drp-btn ghost" onClick={clear}>Clear</button>
          <div className="drp-footer-right">
            <button type="button" className="drp-btn ghost" onClick={cancel}>Cancel</button>
            <button type="button" className="drp-btn primary" onClick={apply}>
              Apply <Icon name="chevronRight" size={14} />
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )
    : null;

  return (
    <div className={`drp-root ${className}`} ref={rootRef}>
      {label ? <span className="drp-field-label">{label}</span> : null}
      <button
        ref={triggerRef}
        type="button"
        className={`drp-trigger ${from || to ? "has-value" : ""} ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="calendar" size={16} />
        <span className="drp-trigger-text">{formatDisplay(from, to)}</span>
      </button>
      {popover}
    </div>
  );
}
