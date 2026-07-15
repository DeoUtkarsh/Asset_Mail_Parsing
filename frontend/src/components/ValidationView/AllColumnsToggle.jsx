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
      className={`vgrid-allcols ${disabled ? "opacity-45 cursor-not-allowed" : "cursor-pointer"}`}
      title={
        enabled
          ? "On: show all columns"
          : "Off: summary columns only (DWT, Built, Coating, Region, Open, Date, Last Cargo)"
      }
    >
      <span className="whitespace-nowrap">
        All columns
        {totalCount > 0 && (
          <span className="opacity-80">
            {" "}({enabled ? totalCount : visibleCount}/{totalCount})
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={() => !disabled && onChange?.(!enabled)}
        className={`vgrid-switch ${enabled ? "on" : ""}`}
      >
        <span />
      </button>
    </label>
  );
}
