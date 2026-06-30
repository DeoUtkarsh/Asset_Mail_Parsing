/** Compact verify-all control for table header / group rows. */
export default function VerifyAllButton({ onClick, disabled, label, className = "" }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap ${className}`}
      style={{
        background: "#fff",
        border: "1px solid #86efac",
        color: "#15803d",
      }}
      title={label}
    >
      {label}
    </button>
  );
}
