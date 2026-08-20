import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getVesselQ88, uploadVesselQ88, vesselQ88DownloadUrl } from "../../services/api";

const GAP = 8;
const EST_W = 420;
const EST_H = 360;

function pickSide(anchorRect, height) {
  const spaceBelow = window.innerHeight - anchorRect.bottom - GAP;
  const spaceAbove = anchorRect.top - GAP;
  const need = Math.min(height || EST_H, 320);
  if (spaceBelow >= need) return "below";
  if (spaceAbove >= need) return "above";
  return spaceAbove > spaceBelow ? "above" : "below";
}

function computePos(anchorEl, popEl, lockedSide) {
  if (!anchorEl) return { top: 0, left: 0, side: lockedSide || "below" };
  const r = anchorEl.getBoundingClientRect();
  const width = popEl?.offsetWidth || EST_W;
  const height = popEl?.offsetHeight || EST_H;
  const side = lockedSide || pickSide(r, height);

  let top;
  if (side === "below") {
    top = r.bottom + GAP;
    if (top + height > window.innerHeight - 12) {
      top = Math.max(12, window.innerHeight - height - 12);
    }
  } else {
    top = r.top - height - GAP;
    if (top < 12) top = 12;
  }

  let left = r.left;
  const maxLeft = window.innerWidth - width - 12;
  if (left > maxLeft) left = Math.max(12, maxLeft);
  if (left < 12) left = 12;

  return { top, left, side };
}

export default function Q88Popover({ row, anchorEl, onClose, onSaved }) {
  const popRef = useRef(null);
  const fileRef = useRef(null);
  const sideRef = useRef(null);
  const [pos, setPos] = useState(() => {
    const p = computePos(anchorEl, null, null);
    sideRef.current = p.side;
    return { top: p.top, left: p.left };
  });
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState("");
  const [mismatch, setMismatch] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [data, setData] = useState(null);

  const place = useCallback(() => {
    if (!anchorEl) return;
    const next = computePos(anchorEl, popRef.current, sideRef.current);
    if (!sideRef.current) sideRef.current = next.side;
    setPos((prev) =>
      prev.top === next.top && prev.left === next.left
        ? prev
        : { top: next.top, left: next.left },
    );
  }, [anchorEl]);

  // Hide until content is loaded and first real layout pass is done — avoids the
  // top-left flash and the second jump when fields replace "Loading…".
  useLayoutEffect(() => {
    if (loading) {
      setReady(false);
      return;
    }
    place();
    setReady(true);
  }, [place, loading, data, mismatch, extracting]);

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
    setReady(false);
    setError("");
    setMismatch(null);
    sideRef.current = pickSide(anchorEl.getBoundingClientRect(), EST_H);
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
  }, [row.id, anchorEl]);

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

  const filled = (data?.fields || []).filter((f) => String(f.value || "").trim()).length;
  const canDownload = Boolean(data?.has_file && data?.filename);

  return createPortal(
    <>
      {loading && anchorEl && (
        <div
          className="q88-pop-boot"
          style={{
            top: Math.min(
              window.innerHeight - 40,
              anchorEl.getBoundingClientRect().bottom + GAP,
            ),
            left: Math.max(12, Math.min(
              window.innerWidth - 140,
              anchorEl.getBoundingClientRect().left,
            )),
          }}
        >
          <span className="spin-ring" /> Loading Q88…
        </div>
      )}
      <div
        ref={popRef}
        className={`q88-pop${ready ? " is-ready" : ""}`}
        style={{ top: pos.top, left: pos.left }}
        role="dialog"
        aria-label="Q88"
        aria-hidden={!ready}
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
            <div className="q88-pop-btns">
              <button
                type="button"
                className="tb-btn tb-btn-primary"
                disabled={extracting}
                onClick={() => fileRef.current?.click()}
              >
                {extracting ? "Scanning…" : data?.filename ? "Replace Q88 PDF" : "Upload Q88 PDF"}
              </button>
              {canDownload && (
                <a
                  className="tb-btn q88-download"
                  href={vesselQ88DownloadUrl(row.id)}
                  download={data.filename}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download PDF
                </a>
              )}
            </div>
            {data?.filename ? (
              <span className="q88-pop-file">{data.filename}</span>
            ) : (
              <span className="q88-pop-file muted">Latest PDF only — a new upload replaces the last extract.</span>
            )}
            {data?.filename && !canDownload && (
              <span className="q88-pop-file muted">Re-upload once to enable Download PDF.</span>
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
              <dl>
                {(data.fields || []).map((f) => (
                  <div key={f.id} className="q88-row">
                    <dt>{f.name}</dt>
                    <dd>{f.value ? f.value : "—"}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </>
      )}
    </div>
    </>,
    document.body
  );
}
