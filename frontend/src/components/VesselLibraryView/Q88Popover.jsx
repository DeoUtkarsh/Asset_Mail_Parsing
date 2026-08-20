import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getVesselQ88, uploadVesselQ88 } from "../../services/api";

const GROUP_LABELS = {
  shared: "Shared vessel master",
  hull: "Hull and machinery",
  emissions: "Emissions and compliance",
  secondary: "Secondary context",
};

export default function Q88Popover({ row, anchorEl, onClose, onSaved }) {
  const popRef = useRef(null);
  const fileRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState("");
  const [mismatch, setMismatch] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [data, setData] = useState(null);

  const place = useCallback(() => {
    if (!anchorEl || !popRef.current) return;
    const r = anchorEl.getBoundingClientRect();
    const pop = popRef.current.getBoundingClientRect();
    const gap = 8;
    let top = r.top - pop.height - gap;
    if (top < 12) top = r.bottom + gap;
    let left = r.left;
    const maxLeft = window.innerWidth - pop.width - 12;
    if (left > maxLeft) left = Math.max(12, maxLeft);
    if (left < 12) left = 12;
    setPos({ top, left });
  }, [anchorEl]);

  useLayoutEffect(() => {
    place();
  }, [place, data, mismatch, extracting, loading]);

  useEffect(() => {
    const onWin = () => place();
    window.addEventListener("scroll", onWin, true);
    window.addEventListener("resize", onWin);
    return () => {
      window.removeEventListener("scroll", onWin, true);
      window.removeEventListener("resize", onWin);
    };
  }, [place]);

  useEffect(() => {
    const onDoc = (e) => {
      if (popRef.current && !popRef.current.contains(e.target) && !anchorEl?.contains(e.target)) {
        onClose();
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorEl, onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setMismatch(null);
    getVesselQ88(row.id)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || "Could not load Q88.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  const runUpload = async (file, ignoreMismatch) => {
    if (!file || extracting) return;
    setExtracting(true);
    setError("");
    setMismatch(null);
    try {
      const res = await uploadVesselQ88(row.id, file, { ignoreMismatch });
      setData(res);
      setPendingFile(null);
      onSaved?.();
    } catch (e) {
      if (e.mismatch) {
        setPendingFile(file);
        setMismatch(e.mismatch);
      } else {
        setError(e.message || "Q88 extract failed.");
      }
    } finally {
      setExtracting(false);
    }
  };

  const groups = [];
  const seen = new Set();
  for (const f of data?.fields || []) {
    const g = f.group || "shared";
    if (!seen.has(g)) {
      seen.add(g);
      groups.push(g);
    }
  }

  const filled = (data?.fields || []).filter((f) => String(f.value || "").trim()).length;

  return createPortal(
    <div
      ref={popRef}
      className="q88-pop"
      style={{ top: pos.top, left: pos.left }}
      role="dialog"
      aria-label="Q88"
    >
      <div className="q88-pop-head">
        <div>
          <h3>Q88</h3>
          <p>{row.vessel_name || "Vessel"}</p>
        </div>
        <button type="button" className="q88-pop-x" onClick={onClose}>✕</button>
      </div>

      {loading ? (
        <div className="q88-pop-status"><span className="spin-ring" /> Loading…</div>
      ) : (
        <>
          <div className="q88-pop-upload">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) runUpload(file, false);
              }}
            />
            <button
              type="button"
              className="tb-btn tb-btn-primary"
              disabled={extracting}
              onClick={() => fileRef.current?.click()}
            >
              {extracting ? "Scanning…" : data?.filename ? "Replace Q88 PDF" : "Upload Q88 PDF"}
            </button>
            {data?.filename ? (
              <span className="q88-pop-file">{data.filename}</span>
            ) : (
              <span className="q88-pop-file muted">Latest PDF only — a new upload replaces the last extract.</span>
            )}
          </div>

          {extracting && (
            <div className="q88-pop-status"><span className="spin-ring" /> Q88 agent scanning PDF…</div>
          )}
          {error && <div className="q88-pop-err">{error}</div>}
          {mismatch && (
            <div className="q88-pop-warn">
              <p>{mismatch.message}</p>
              <button
                type="button"
                className="tb-btn"
                disabled={extracting || !pendingFile}
                onClick={() => runUpload(pendingFile, true)}
              >
                Ignore
              </button>
            </div>
          )}

          {(data?.fields || []).length > 0 && (
            <div className="q88-pop-fields">
              <div className="q88-pop-count">{filled} fields filled</div>
              {groups.map((g) => (
                <section key={g}>
                  <h4>{GROUP_LABELS[g] || g}</h4>
                  <dl>
                    {(data.fields || [])
                      .filter((f) => (f.group || "shared") === g)
                      .map((f) => (
                        <div key={f.id} className="q88-row">
                          <dt>
                            <span className="q88-ref">{f.q88_ref}</span>
                            {f.name}
                          </dt>
                          <dd>{f.value ? f.value : "—"}</dd>
                        </div>
                      ))}
                  </dl>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>,
    document.body
  );
}
