/**
 * Vessel Position List — off: fixed summary columns; on: all columns.
 */
export default function AllColumnsToggle({
  enabled = false,
  onChange,
  visibleCount = 0,
  totalCount = 0,
  disabled = false,
}) {
  return (
    <label
      className={`inline-flex items-center gap-2 h-[30px] select-none ${
        disabled ? "opacity-45 cursor-not-allowed" : "cursor-pointer"
      }`}
      title={
        enabled
          ? "On: show all columns"
          : "Off: summary columns only (DWT, Built, Coating, Region, Open, Date, Last Cargo)"
      }
    >
      <span className="text-[11px] font-medium whitespace-nowrap" style={{ color: "#e0f2fe" }}>
        All columns
        {totalCount > 0 && (
          <span className="ml-1 opacity-90">
            ({enabled ? totalCount : visibleCount}/{totalCount})
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={() => !disabled && onChange?.(!enabled)}
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        style={{
          background: enabled ? "#38bdf8" : "#64748b",
          border: `1px solid ${enabled ? "#0ea5e9" : "#475569"}`,
        }}
      >
        <span
          className="inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200"
          style={{
            transform: enabled ? "translateX(18px)" : "translateX(2px)",
          }}
        />
      </button>
    </label>
  );
}
