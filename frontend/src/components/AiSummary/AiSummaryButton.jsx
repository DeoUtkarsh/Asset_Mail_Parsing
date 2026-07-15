import { useState, useCallback } from "react";
import AiSummaryModal from "./AiSummaryModal";

/**
 * Opens modal and fetches a fresh summary every time (onOpen + Refresh).
 * `fetchSummary` should call the API with current tab context (ids, selection).
 */
export default function AiSummaryButton({
  fetchSummary,
  title = "AI Summary",
  disabled = false,
  className = "",
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);

  const runFetch = useCallback(async () => {
    setLoading(true);
    setError("");
    setData(null);
    try {
      const result = await fetchSummary();
      setData(result);
    } catch (e) {
      setError(e.message || "Could not generate summary.");
    } finally {
      setLoading(false);
    }
  }, [fetchSummary]);

  const handleOpen = () => {
    setOpen(true);
    runFetch();
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        className={
          className
          || "flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-all shadow-sm bg-white text-sky-800 hover:bg-sky-50 disabled:opacity-40 disabled:cursor-not-allowed"
        }
        style={className ? undefined : { border: "1px solid #bae6fd" }}
        title="Fresh AI briefing from current page data"
      >
        <span aria-hidden>✨</span>
        AI Summary
      </button>

      <AiSummaryModal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        loading={loading}
        error={error}
        data={data}
        onRefresh={runFetch}
      />
    </>
  );
}
