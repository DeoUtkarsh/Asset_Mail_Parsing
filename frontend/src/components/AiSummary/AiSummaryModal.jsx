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

function MatchBriefBody({ facts }) {
  const hot = facts.hot_list || [];
  const dead = facts.dead_weight || [];
  const chips = facts.zone_chips || [];
  const deadCount = facts.dead_weight_count ?? dead.length;

  return (
    <div className="aisum-brief">
      {facts.urgency_line ? (
        <div className="aisum-callout">{facts.urgency_line}</div>
      ) : null}

      <section className="aisum-section">
        <div className="aisum-section-head">
          <h4>Hot list</h4>
          <span>Call these first</span>
        </div>
        {hot.length === 0 ? (
          <p className="aisum-empty">No strong candidates yet — fill opens and regions.</p>
        ) : (
          <div className="aisum-table-wrap">
            <table className="aisum-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Vessel</th>
                  <th>Region</th>
                  <th>Open</th>
                  <th>DWT</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {hot.map((row, i) => (
                  <tr key={row.id || `${row.vessel_name}-${i}`}>
                    <td className="aisum-num">{i + 1}</td>
                    <td className="aisum-name">{row.vessel_name}</td>
                    <td>{row.region || "—"}</td>
                    <td>{row.opening_date || "—"}</td>
                    <td className="aisum-num">{row.dwt || "—"}</td>
                    <td className="aisum-why">{row.why || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="aisum-section">
        <div className="aisum-section-head">
          <h4>Dead weight</h4>
          <span>{deadCount} incomplete — fix before matching</span>
        </div>
        {dead.length === 0 ? (
          <p className="aisum-empty">No heavy gaps in the current set.</p>
        ) : (
          <ul className="aisum-dead">
            {dead.map((row, i) => (
              <li key={`${row.vessel_name}-${i}`}>
                <span className="aisum-name">{row.vessel_name}</span>
                <span className="aisum-miss">
                  missing {(row.missing || []).join(", ")}
                </span>
              </li>
            ))}
            {deadCount > dead.length ? (
              <li className="aisum-dead-more">+{deadCount - dead.length} more</li>
            ) : null}
          </ul>
        )}
      </section>

      {chips.length > 0 ? (
        <section className="aisum-section">
          <div className="aisum-section-head">
            <h4>Coverage</h4>
            <span>By trade zone</span>
          </div>
          <div className="aisum-chips">
            {chips.map((c) => (
              <span
                key={c.zone}
                className="aisum-chip"
                style={{ borderColor: c.color, background: `${c.color}14` }}
              >
                <i style={{ background: c.color }} />
                {c.zone}
                <b>{c.count}</b>
              </span>
            ))}
          </div>
        </section>
      ) : null}
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

  const isMatchBrief = data?.facts?.layout === "match_brief";

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
      <div
        className={`aisum-modal ${isMatchBrief ? "aisum-modal-wide" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
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
              Building match brief…
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

              {isMatchBrief ? (
                <MatchBriefBody facts={data.facts} />
              ) : (
                <>
                  {data.narrative ? (
                    <div className="aisum-narrative aisum-desknote">
                      {String(data.narrative).split("\n").map((line, i) => (
                        <p key={i} className="aisum-deskline">{line}</p>
                      ))}
                    </div>
                  ) : null}

                  {data.facts?.urgency === "high" && (
                    <p className="aisum-urgent">
                      Urgent openings detected — prioritize near-term positions.
                    </p>
                  )}

                  {charts.length > 0 && (
                    <div className="aisum-charts">
                      <h4 className="aisum-charts-label">Breakdown</h4>
                      {charts.map((chart) => (
                        <SummaryBarChart key={chart.title} chart={chart} />
                      ))}
                    </div>
                  )}
                </>
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
              Copy brief
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
