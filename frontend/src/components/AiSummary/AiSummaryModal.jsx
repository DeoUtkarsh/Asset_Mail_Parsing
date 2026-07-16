import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

function SummaryBarChart({ chart }) {
  if (!chart?.items?.length) return null;
  const max = Math.max(...chart.items.map((i) => i.value), 1);

  return (
    <div className="aisum-chart">
      <h4 className="aisum-chart-title">{chart.title}</h4>
      {chart.items.map((item) => (
        <div key={item.label} className="aisum-row">
          <span className="aisum-row-label" title={item.label}>
            {item.label}
          </span>
          <div className="aisum-track">
            <div
              className="aisum-fill"
              style={{
                width: `${(item.value / max) * 100}%`,
                background: item.color || undefined,
                minWidth: item.value > 0 ? 4 : 0,
              }}
            />
          </div>
          <span className="aisum-row-val">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function AiSummaryModal({
  open,
  onClose,
  title = "AI Summary",
  loading = false,
  error = "",
  data = null,
  onRefresh,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleCopy = useCallback(() => {
    if (!data?.narrative) return;
    navigator.clipboard.writeText(data.narrative).catch(() => {});
  }, [data]);

  if (!open) return null;

  const stats = data?.facts?.headline_stats || [];
  const charts = data?.facts?.charts || [];
  const generatedAt = data?.facts?.generated_at;

  return createPortal(
    <div className="aisum-bg" onClick={onClose}>
      <div className="aisum-modal" onClick={(e) => e.stopPropagation()}>
        <div className="aisum-head">
          <span className="aisum-head-title">
            <span className="aisum-spark" aria-hidden>✨</span>
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="aisum-close"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="aisum-body">
          {loading && (
            <div className="aisum-loading">
              <span className="aisum-spin" />
              Analyzing current data…
            </div>
          )}

          {!loading && error && <div className="aisum-error">{error}</div>}

          {!loading && !error && data && (
            <>
              {stats.length > 0 && (
                <div className="aisum-stats">
                  {stats.map((s) => (
                    <div key={s.label} className="aisum-stat">
                      <span className="aisum-stat-label">{s.label}</span>
                      <span className="aisum-stat-val">{s.value}</span>
                    </div>
                  ))}
                </div>
              )}

              {charts.map((chart) => (
                <SummaryBarChart key={chart.title} chart={chart} />
              ))}

              <div className="aisum-narrative">{data.narrative}</div>

              {data.facts?.urgency === "high" && (
                <p className="aisum-urgent">
                  ⚡ Urgent openings detected — prioritize near-term positions.
                </p>
              )}

              {generatedAt && (
                <p className="aisum-gen">
                  Generated {new Date(generatedAt).toLocaleString()} · fresh from current data
                </p>
              )}
            </>
          )}
        </div>

        {!loading && data?.narrative && (
          <div className="aisum-foot">
            <button type="button" onClick={onRefresh} className="aisum-btn">
              Refresh
            </button>
            <button type="button" onClick={handleCopy} className="aisum-btn primary">
              Copy summary
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
