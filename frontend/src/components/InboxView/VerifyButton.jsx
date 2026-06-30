/**
 * Single toggle button — Verify / ✓ Verified (click again to un-verify). Fixed size.
 */
export default function VerifyButton({
  verified = false,
  canVerify = false,
  busy = false,
  onToggle,
}) {
  const enabled = verified || canVerify;

  return (
    <button
      type="button"
      disabled={!enabled || busy}
      onClick={onToggle}
      className="inline-flex items-center justify-center min-w-[92px] h-[30px] px-3 rounded-lg text-xs font-semibold transition-colors shadow-sm disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap"
      style={
        verified
          ? { background: "#16a34a", border: "1px solid #15803d", color: "#fff" }
          : !enabled || busy
            ? { background: "#f8fafc", border: "1px solid #e2e8f0", color: "#94a3b8" }
            : { background: "#fff", border: "1px solid #86efac", color: "#15803d" }
      }
      title={
        verified
          ? "Click to un-verify"
          : !canVerify
            ? "Requires downloaded status and at least one vessel"
            : "Send vessels to Vessel Position List"
      }
    >
      {verified ? "✓ Verified" : "Verify"}
    </button>
  );
}
