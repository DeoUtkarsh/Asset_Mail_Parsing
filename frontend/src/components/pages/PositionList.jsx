import ZoneMap, { ZONE_COLORS } from "../ZoneMap";
import { STD_COLUMNS } from "../../lib/positions";

export default function PositionList({ draft, draftLoading, need, positions, allColumns = [], columns = STD_COLUMNS, onColumnsChange, onGenerate, onCopy, onSend, onGo }) {
  const zones = draft.zones || [];
  const hasDraft = Boolean(draft.html);

  const usedKeys = new Set(columns.flatMap((c) => c.keys));
  const available = allColumns.filter((k) => k !== "region" && !usedKeys.has(k));
  const addColumn = (key) => onColumnsChange?.([...columns, { header: key.replace(/_/g, " ").toUpperCase(), keys: [key] }]);
  const removeColumn = (i) => onColumnsChange?.(columns.filter((_, j) => j !== i));

  return (
    <div className="wrap">
      <button className="backlink" onClick={() => onGo("today")}>← Back to Today</button>
      <div className="pagehead pagehead-row">
        <div className="ph-title">
          <h1>Position List</h1>
          <p>Auto-compiled from every parsed owner email, grouped by zone.</p>
        </div>
        <div className="send-actions">
          <button className="tb-btn" onClick={onGenerate} disabled={draftLoading}>
            {draftLoading ? <><span className="spin-ring" /> Building…</> : "↻ Rebuild"}
          </button>
          <button className="btn btn-ghost" onClick={onCopy} disabled={!hasDraft}>⎘ Copy</button>
          <button className="btn btn-send" onClick={onSend} disabled={!hasDraft || need > 0}>📤 Send to charterers</button>
        </div>
      </div>
      {need > 0 && <div className="gate">⚠️ {need} position{need !== 1 ? "s" : ""} still need review before sending.</div>}

      {/* ── Column picker ── */}
      <div className="col-picker">
        <div className="cp-lbl">Columns in the email</div>
        <div className="cp-chips">
          {columns.map((c, i) => (
            <span className="cp-chip" key={c.header}>
              {c.header}
              <button title="Remove column" onClick={() => removeColumn(i)}>×</button>
            </span>
          ))}
          {available.length > 0 && (
            <select className="cp-add" value="" onChange={(e) => { if (e.target.value) addColumn(e.target.value); }}>
              <option value="">＋ Add column…</option>
              {available.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
            </select>
          )}
          <button className="cp-reset" onClick={() => onColumnsChange?.(STD_COLUMNS)}>Reset to standard</button>
        </div>
        <div className="cp-hint">Empty columns are auto-hidden per zone · click <b>↻ Rebuild</b> to apply changes</div>
      </div>

      {draftLoading ? (
        <div className="center-load"><span className="spin-ring" /> Compiling the position list…</div>
      ) : !hasDraft ? (
        <div className="empty">
          <div className="em">🚢</div>
          <h2>No list compiled yet</h2>
          <p>Build the consolidated position list from the parsed positions.</p>
          <div><button className="fetch-btn" onClick={onGenerate}>Compile position list</button></div>
        </div>
      ) : (
        <div className="listgrid" style={{ marginTop: 12 }}>
          <div>
            <div className="mapwrap"><ZoneMap zones={zones} /></div>
            <div className="sidecard">
              <h5>Zones · {positions} positions</h5>
              {zones.map((z) => (
                <div className="lr" key={z.name}>
                  <span className="sw" style={{ background: ZONE_COLORS[z.name] || "#94a3b8" }} />
                  {z.name} <b>{z.count}</b>
                </div>
              ))}
            </div>
            <div className="sidecard">
              <h5>Recipients <span className="disabled-note">soon</span></h5>
              <div className="recip"><span className="av">DC</span> Dry Cargo desk · 22</div>
              <div className="recip"><span className="av">AG</span> AG charterers · 12</div>
            </div>
          </div>
          <iframe className="mailframe" title="Position list" srcDoc={draft.html} sandbox="allow-same-origin" />
        </div>
      )}
    </div>
  );
}
