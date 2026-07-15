import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

function SummaryBarChart({ chart }) {
  if (!chart?.items?.length) return null;
  const max = Math.max(...chart.items.map((i) => i.value), 1);

  return (
    <div className="mb-4">
      <h4 className="text-xs font-bold mb-2" style={{ color: "#0369a1" }}>
        {chart.title}
      </h4>
      <div className="flex flex-col gap-1.5">
        {chart.items.map((item) => (
          <div key={item.label} className="flex items-center gap-2 text-[11px]">
            <span
              className="w-28 shrink-0 truncate text-right"
              style={{ color: "#0c4a6e" }}
              title={item.label}
            >
              {item.label}
            </span>
            <div
              className="flex-1 h-4 rounded overflow-hidden"
              style={{ background: "#e0f2fe" }}
            >
              <div
                className="h-full rounded transition-all duration-500"
                style={{
                  width: `${(item.value / max) * 100}%`,
                  background: item.color || "#0369a1",
                  minWidth: item.value > 0 ? 4 : 0,
                }}
              />
            </div>
            <span className="w-6 text-right font-bold shrink-0" style={{ color: "#0369a1" }}>
              {item.value}
            </span>
          </div>
        ))}
      </div>
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
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "rgba(12, 74, 110, 0.55)" }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg max-h-[85vh] rounded-2xl shadow-2xl flex flex-col min-h-0 overflow-hidden"
        style={{ background: "#f0f9ff", border: "1px solid #bae6fd" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0"
          style={{ background: "linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%)" }}
        >
          <div className="flex items-center gap-2">
            <span className="text-lg" aria-hidden>✨</span>
            <span className="text-sm font-bold text-white">{title}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-lg leading-none text-white/90 hover:bg-white/10"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-sm" style={{ color: "#0369a1" }}>
              <span className="inline-block w-8 h-8 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
              Analyzing current data…
            </div>
          )}

          {!loading && error && (
            <div
              className="px-4 py-3 rounded-lg text-sm"
              style={{ background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626" }}
            >
              {error}
            </div>
          )}

          {!loading && !error && data && (
            <>
              {stats.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {stats.map((s) => (
                    <div
                      key={s.label}
                      className="px-2.5 py-1 rounded-md text-[11px] shadow-sm"
                      style={{ background: "#fff", border: "1px solid #bae6fd" }}
                    >
                      <span style={{ color: "#7dd3fc" }}>{s.label}: </span>
                      <span className="font-bold" style={{ color: "#0369a1" }}>{s.value}</span>
                    </div>
                  ))}
                </div>
              )}

              {charts.map((chart) => (
                <SummaryBarChart key={chart.title} chart={chart} />
              ))}

              <div
                className="rounded-xl px-4 py-3 text-sm leading-relaxed"
                style={{ background: "#fff", border: "1px solid #bae6fd", color: "#0c4a6e" }}
              >
                {data.narrative}
              </div>

              {data.facts?.urgency === "high" && (
                <p className="mt-3 text-xs font-semibold" style={{ color: "#b45309" }}>
                  ⚡ Urgent openings detected — prioritize near-term positions.
                </p>
              )}

              {generatedAt && (
                <p className="mt-3 text-[10px] text-right" style={{ color: "#7dd3fc" }}>
                  Generated {new Date(generatedAt).toLocaleString()} · fresh from current data
                </p>
              )}
            </>
          )}
        </div>

        {!loading && data?.narrative && (
          <div
            className="flex items-center justify-end gap-2 px-5 py-3 flex-shrink-0"
            style={{ borderTop: "1px solid #bae6fd", background: "#e0f2fe" }}
          >
            <button
              type="button"
              onClick={onRefresh}
              className="px-3 py-1.5 rounded-lg text-xs font-medium"
              style={{ color: "#0369a1", border: "1px solid #bae6fd", background: "#fff" }}
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-white"
              style={{ background: "#0369a1" }}
            >
              Copy summary
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
