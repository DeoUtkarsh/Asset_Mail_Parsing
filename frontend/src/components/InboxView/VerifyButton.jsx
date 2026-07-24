/**
 * Toggle button — Verify / Verified. Verified vessels appear on Vessel Position List.
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
          ? "Verified — click to remove from Vessel Position List"
          : !canVerify
            ? "Requires synced status and at least one vessel"
            : "Send vessels to Vessel Position List"
      }
    >
      {busy
        ? <span className="spin-ring" style={{ width: 12, height: 12 }} />
        : verified
          ? "Verified"
          : "Verify"}
    </button>
  );
}
