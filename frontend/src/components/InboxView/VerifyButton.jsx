/**
 * Verified = status badge (not clickable).
 * Not verified = Verify button (sends vessels to Vessel Position List).
 */
export default function VerifyButton({
  verified = false,
  canVerify = false,
  busy = false,
  onVerify,
}) {
  if (verified) {
    return (
      <span
        className="badge-verified"
        title="Verified — on Vessel Position List. Edit and save changes to re-verify."
      >
        Verified
      </span>
    );
  }

  const enabled = canVerify && !busy;

  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => onVerify?.()}
      className={enabled ? "btn-verify can-verify" : "btn-verify"}
      title={
        !canVerify
          ? "Requires synced status and at least one vessel"
          : "Send vessels to Vessel Position List"
      }
    >
      {busy ? <span className="spin-ring" style={{ width: 12, height: 12 }} /> : "Verify"}
    </button>
  );
}
