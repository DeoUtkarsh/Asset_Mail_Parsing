import Icon from "../icons";

const STEPS = [
  { key: "received", label: "Received", unit: "emails", fact: "emails_received" },
  { key: "parsed", label: "Parsed", unit: "vessels", fact: "positions_parsed" },
  { key: "compiled", label: "Compiled", unit: "zones", fact: "zones" },
  { key: "review", label: "Review", unit: "to check", fact: "review_count" },
];

export default function HomeView({ data, loading = false, error = "", onNavigate, onRefresh }) {
  const load = () => onRefresh?.();

  const f = data?.facts || {};
  const readiness = f.readiness_pct ?? 0;
  const reviewCount = f.review_count ?? 0;
  const positionsReady = f.positions_ready ?? 0;
  const positionsParsed = f.positions_parsed ?? 0;
  const zones = f.zones ?? 0;

  const todayLabel = new Date().toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const headline =
    positionsReady > 0 && reviewCount === 0
      ? "Ready to send"
      : positionsReady > 0
        ? "Almost ready to send"
        : positionsParsed > 0
          ? "Positions parsed — review pending"
          : "Waiting for your first sync";

  const stepState = (key) => {
    switch (key) {
      case "received": return f.emails_received > 0 ? "done" : "pending";
      case "parsed": return positionsParsed > 0 ? "done" : "pending";
      case "compiled": return zones > 0 ? "done" : "pending";
      case "review": return reviewCount > 0 ? "current" : positionsReady > 0 ? "done" : "pending";
      default: return "pending";
    }
  };

  return (
    <div className="home-root">
      {error ? (
        <div className="home-error">{error}</div>
      ) : (
        <>
          <div className="home-card home-overview">
            <div className="home-head">
              <div className="home-head-center">
                <span className="home-head-pill"><Icon name="anchor" size={15} /> AI Summary</span>
                <div className="home-head-date">{todayLabel}</div>
              </div>
              <button type="button" className="home-refresh" onClick={load} disabled={loading} title="Refresh">
                {loading ? <span className="spin-ring" /> : "↻"} Refresh
              </button>
            </div>

            <div className="home-summary">
              <div className="home-ring" style={{ "--pct": `${readiness}%` }}>
                <div className="home-ring-inner">
                  <b>{readiness}%</b>
                  <span>READY</span>
                </div>
              </div>
              <div className="home-summary-text">
                <h2>{loading ? "Loading…" : headline}</h2>
                <p>{loading ? "Crunching the latest numbers…" : (data?.narrative || "")}</p>
              </div>
            </div>

            <div className="home-stepper">
              {STEPS.map((s, i) => {
                const state = stepState(s.key);
                const value = s.fact ? (f[s.fact] ?? 0) : null;
                return (
                  <div key={s.key} className="home-step-wrap">
                    {i > 0 && <div className={`home-step-line ${state !== "pending" ? "on" : ""}`} />}
                    <div className={`home-step ${state}`}>
                      <div className="home-step-dot">
                        {state === "done" ? "✓" : state === "current" ? value : <Icon name="navigation" size={13} />}
                      </div>
                      <div className="home-step-label">{s.label}</div>
                      <div className="home-step-sub">
                        {value != null ? `${value} ${s.unit}` : s.unit}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="home-actions">
            <button
              type="button"
              className="home-action review"
              onClick={() => onNavigate?.("review")}
            >
              <div className="home-action-num">{reviewCount}</div>
              <div className="home-action-title">Need your review</div>
              <div className="home-action-sub">
                Emails with low/medium confidence or missing data — a quick check each.
              </div>
              <div className="home-action-link">Review now →</div>
            </button>

            <button
              type="button"
              className="home-action ready"
              onClick={() => onNavigate?.("today")}
            >
              <div className="home-action-num">{positionsReady}</div>
              <div className="home-action-title">Positions ready</div>
              <div className="home-action-sub">
                Verified into {zones} zone{zones !== 1 ? "s" : ""}, ready for charterers.
              </div>
              <div className="home-action-link">Open position list →</div>
            </button>
          </div>

          <div className="home-agents">
            <div className="home-agent live">
              <div className="home-agent-ic"><Icon name="anchor" size={18} /></div>
              <div className="home-agent-name">Vessel Position Agent</div>
              <div className="home-agent-chip">Open Positions {positionsReady}</div>
            </div>

            <div className="home-agent disabled">
              <div className="home-agent-ic"><Icon name="navigation" size={18} /></div>
              <div className="home-agent-name">Vessel Sell and Purchase Agent</div>
              <div className="home-agent-chip">Coming soon</div>
            </div>

            <div className="home-agent disabled">
              <div className="home-agent-ic"><Icon name="alert" size={18} /></div>
              <div className="home-agent-name">Commercial Intelligence Agent</div>
              <div className="home-agent-chip">Coming soon</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
