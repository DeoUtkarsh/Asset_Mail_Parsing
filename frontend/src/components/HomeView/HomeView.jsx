import Icon from "../icons";

export default function HomeView({ data, loading = false, error = "", onNavigate, onRefresh }) {
  const load = () => onRefresh?.();

  const f = data?.facts || {};
  const reviewCount = f.review_count ?? 0;
  const positionsReady = f.positions_ready ?? 0;
  const positionsParsed = f.positions_parsed ?? 0;
  const zones = f.zones ?? 0;
  // Only blank the page on the first load — Refresh must keep showing current numbers
  // until the new summary arrives (avoids half-updated "Loading…" + stale KPIs).
  const showBootLoading = loading && !data;

  const todayLabel = new Date().toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const headline =
    positionsReady > 0 && reviewCount === 0
      ? "Morning brief"
      : positionsReady > 0
        ? "Almost ready to send"
        : positionsParsed > 0
          ? "Positions parsed — review pending"
          : "Waiting for your first sync";

  return (
    <div className="home-root">
      {error ? (
        <div className="home-error">{error}</div>
      ) : (
        <>
          <div className="home-overview">
            <div className="home-head">
              <div className="home-head-center">
                <span className="home-head-pill"><Icon name="anchor" size={15} /> AI Summary</span>
                <div className="home-head-date">{todayLabel}</div>
              </div>
              <button type="button" className="home-refresh" onClick={load} disabled={loading} title="Refresh">
                {loading ? <span className="spin-ring" /> : "↻"} Refresh
              </button>
            </div>

            <div className="home-summary home-summary--text-only">
              <div className="home-summary-text">
                <h2>{showBootLoading ? "Loading…" : headline}</h2>
                <p>{showBootLoading ? "Crunching the latest numbers…" : (data?.narrative || "")}</p>
              </div>
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
            <button type="button" className="home-agent live" onClick={() => onNavigate?.("today")}>
              <div className="home-agent-ic"><Icon name="anchor" size={18} /></div>
              <div className="home-agent-name">Vessel Position Agent</div>
              <div className="home-agent-chip">Open Positions {positionsReady}</div>
            </button>

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
