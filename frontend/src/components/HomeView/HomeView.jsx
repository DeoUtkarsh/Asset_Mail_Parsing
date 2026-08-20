import Icon from "../icons";
import { formatDayLabel, useUtcCalendar } from "../../lib/calendarDay";

export default function HomeView({ data, loading = false, error = "", onNavigate }) {
  const f = data?.facts || {};
  const reviewCount = f.review_count ?? 0;
  const positionsReady = f.positions_ready ?? 0;
  const positionsParsed = f.positions_parsed ?? 0;
  const zones = f.zones ?? 0;
  const hasData = Boolean(data);
  const showBootLoading = loading && !hasData;
  const refreshing = loading && hasData;
  const useUtc = useUtcCalendar();
  const dayKey = f.summary_day || null;

  const stampLabel = dayKey
    ? formatDayLabel(dayKey, useUtc)
    : new Date().toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      });

  const narrative = data?.narrative || "No summary yet for today.";

  return (
    <div className="home-root">
      {error ? (
        <div className="home-error">{error}</div>
      ) : (
        <>
          <div className="home-brief">
            <div className="home-brief-head">
              <h1 className="home-brief-title">AI Morning Brief</h1>
              <span className="home-brief-dot" aria-hidden="true">·</span>
              <span className="home-brief-stamp">{stampLabel}</span>
            </div>

            {/* Fixed-height slot so KPI cards never jump when narrative loads */}
            <div className="home-brief-summary" aria-live="polite">
              {showBootLoading ? (
                <div className="home-brief-summary-loading">
                  <span className="spin-ring" aria-hidden="true" />
                  <span>Crunching today’s numbers…</span>
                </div>
              ) : (
                <p className="home-brief-narrative">{narrative}</p>
              )}
            </div>

            <div className="home-brief-card" role="group" aria-label="Today’s actions">
              <button
                type="button"
                className="home-brief-stat review"
                onClick={() => onNavigate?.("review")}
              >
                <span className="home-brief-ic review" aria-hidden="true">
                  <Icon name="alert" size={14} />
                </span>
                <span className="home-brief-num">
                  {showBootLoading ? "0" : reviewCount}
                </span>
                <span className="home-brief-copy">
                  <span className="home-brief-stat-title">Need your review</span>
                  <span className="home-brief-stat-sub">
                    Today · low/medium confidence or missing data
                  </span>
                </span>
              </button>

              <div className="home-brief-divider" aria-hidden="true" />

              <button
                type="button"
                className="home-brief-stat ready"
                onClick={() => onNavigate?.("today")}
              >
                <span className="home-brief-ic ready" aria-hidden="true">
                  <Icon name="ship" size={14} />
                </span>
                <span className="home-brief-num">
                  {showBootLoading ? "0" : positionsReady}
                </span>
                <span className="home-brief-copy">
                  <span className="home-brief-stat-title">Positions ready</span>
                  <span className="home-brief-stat-sub">
                    Today · verified into {zones} zone{zones !== 1 ? "s" : ""}
                    {positionsParsed ? ` · ${positionsParsed} parsed` : ""}
                  </span>
                </span>
              </button>
            </div>
          </div>

          <div className="home-agents">
            <button type="button" className="home-agent live" onClick={() => onNavigate?.("today")}>
              <div className="home-agent-ic"><Icon name="anchor" size={16} /></div>
              <div className="home-agent-name">Vessel Position Agent</div>
              <div className="home-agent-chip">Open Positions {showBootLoading ? 0 : positionsReady}</div>
            </button>

            <div className="home-agent disabled">
              <div className="home-agent-ic"><Icon name="navigation" size={16} /></div>
              <div className="home-agent-name">Vessel Sell and Purchase Agent</div>
              <div className="home-agent-chip">Coming soon</div>
            </div>

            <div className="home-agent disabled">
              <div className="home-agent-ic"><Icon name="alert" size={16} /></div>
              <div className="home-agent-name">Commercial Intelligence Agent</div>
              <div className="home-agent-chip">Coming soon</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
