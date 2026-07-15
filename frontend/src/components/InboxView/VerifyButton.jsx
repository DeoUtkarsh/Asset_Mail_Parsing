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
  const cls = verified
    ? "btn-verify is-verified"
    : enabled && !busy
      ? "btn-verify can-verify"
      : "btn-verify";

  return (
    <button
      type="button"
      disabled={!enabled || busy}
      onClick={onToggle}
      className={cls}
      title={
        verified
          ? "Click to un-verify"
          : !canVerify
            ? "Requires downloaded status and at least one vessel"
            : "Send vessels to Vessel Position List"
      }
    >
      {busy ? <span className="spin-ring" style={{ width: 12, height: 12 }} /> : verified ? "✓ Verified" : "Verify"}
    </button>
  );
}
