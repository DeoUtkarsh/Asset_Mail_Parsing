import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  getVesselLibrary,
  addVesselLibrary,
  updateVesselLibrary,
  deleteVesselLibrary,
} from "../../services/api";
import Icon from "../icons";

const COLS = [
  { key: "vessel_name", label: "Name of vessel", ph: "e.g. AMICO PEARL" },
  { key: "dwt", label: "DWT", ph: "e.g. 74,900" },
  { key: "year_built", label: "Year built", ph: "e.g. 2013" },
  { key: "tank_coating", label: "Tank coating", ph: "e.g. EPOXY" },
  { key: "imo_type", label: "IMO type", ph: "e.g. IMO II" },
  { key: "imo_no", label: "IMO no.", ph: "e.g. 9412233" },
  { key: "vessel_type", label: "Vessel type", ph: "e.g. MR Product Tanker" },
];

const BLANK = COLS.reduce((acc, c) => ({ ...acc, [c.key]: "" }), {});

export default function VesselLibraryView({ isActive = false, refreshKey = 0, onLibraryUpdated }) {
  const [rows, setRows] = useState([]);
  const [newRows, setNewRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ key: null, dir: "asc" });
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const savedTimer = useRef(null);

  // modal: { mode: "add" | "edit" | "review", data }
  const [modal, setModal] = useState(null);

  const flashSaved = () => {
    setSavedMsg(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedMsg(false), 2000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getVesselLibrary();
      setRows(data.vessels || []);
      setNewRows(data.new_vessels || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isActive) load();
  }, [isActive, refreshKey, load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      COLS.some((c) => String(r[c.key] || "").toLowerCase().includes(q))
    );
  }, [rows, query]);

  const sorted = useMemo(() => {
    if (!sort.key) return filtered;
    const { key, dir } = sort;
    const factor = dir === "asc" ? 1 : -1;
    const numericKeys = new Set(["dwt", "year_built", "imo_no"]);
    const parseNum = (v) => {
      const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
      return isNaN(n) ? null : n;
    };
    const isEmpty = (v) => v == null || String(v).trim() === "" || String(v).trim() === "—";
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      const ae = isEmpty(av);
      const be = isEmpty(bv);
      if (ae && be) return 0;
      if (ae) return 1; // blanks always last
      if (be) return -1;
      if (numericKeys.has(key)) {
        const an = parseNum(av);
        const bn = parseNum(bv);
        if (an != null && bn != null) return (an - bn) * factor;
        if (an != null) return -1;
        if (bn != null) return 1;
      }
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * factor;
    });
    return arr;
  }, [filtered, sort]);

  const toggleSort = useCallback((key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }, []);

  const handleSave = async (fields) => {
    setSaving(true);
    setError("");
    try {
      if (modal?.mode === "edit" && modal.data?.id) {
        await updateVesselLibrary(modal.data.id, fields);
      } else {
        await addVesselLibrary(fields);
      }
      setModal(null);
      flashSaved();
      await load();
      onLibraryUpdated?.();
    } catch (e) {
      setError("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row) => {
    if (!window.confirm(`Remove "${row.vessel_name || "this vessel"}" from the library?`)) return;
    setError("");
    try {
      await deleteVesselLibrary(row.id);
      await load();
      onLibraryUpdated?.();
    } catch (e) {
      setError("Delete failed: " + e.message);
    }
  };

  return (
    <div className="vgrid-root">
      <div className="vgrid-head">
        <h2>Vessel Libraries List</h2>
        <div className="vgrid-actions">
          <span className={`vgrid-saved ${savedMsg ? "show" : ""}`}>✓ Saved</span>
          <div className="lp-search vlib-search">
            <Icon name="search" size={15} />
            <input
              placeholder="Search vessel name, IMO no…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="tb-btn tb-btn-primary"
            onClick={() => setModal({ mode: "add", data: { ...BLANK } })}
          >
            <Icon name="plus" size={15} /> Add a vessel
          </button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="vgrid-stats">
          <LibStat label="Vessels in library" value={rows.length} />
          {newRows.length > 0 && <LibStat label="New to review" value={newRows.length} />}
        </div>
      )}

      {error && <div className="vgrid-err">{error}</div>}

      <div className="vgrid-body vlib-body">
        {loading ? (
          <div className="center-load"><span className="spin-ring" /> Loading vessel library…</div>
        ) : (
          <div className="vessel-grid-wrap">
            <div className="vessel-grid-scroll">
              <table className="vessel-grid vlib-grid">
                <thead>
                  <tr>
                    <th style={{ width: 46 }}>SR.</th>
                    {COLS.map((c) => {
                      const active = sort.key === c.key;
                      return (
                        <th
                          key={c.key}
                          className="vlib-th-sort"
                          onClick={() => toggleSort(c.key)}
                          title={`Sort by ${c.label}`}
                        >
                          <span className="vlib-th-inner">
                            {c.label}
                            <span className={`vlib-sort-ic ${active ? "on" : ""}`}>
                              {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                            </span>
                          </span>
                        </th>
                      );
                    })}
                    <th style={{ width: 84 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.length === 0 ? (
                    <tr>
                      <td colSpan={COLS.length + 2} className="vlib-empty-cell">
                        {rows.length === 0
                          ? "No vessels in the library yet. Fetch emails or click “Add a vessel”."
                          : "No vessels match your search."}
                      </td>
                    </tr>
                  ) : (
                    sorted.map((row, i) => (
                      <tr key={row.id}>
                        <td className="vlib-sr">{i + 1}</td>
                        {COLS.map((c) => (
                          <td key={c.key} className={row[c.key] ? "" : "vlib-blank"}>
                            {row[c.key] || "—"}
                          </td>
                        ))}
                        <td className="vlib-actions">
                          <button
                            type="button"
                            className="vlib-icon-btn"
                            title="Edit"
                            onClick={() => setModal({ mode: "edit", data: { ...row } })}
                          >
                            <Icon name="edit" size={15} />
                          </button>
                          <button
                            type="button"
                            className="vlib-icon-btn danger"
                            title="Delete"
                            onClick={() => handleDelete(row)}
                          >
                            <Icon name="trash" size={15} />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && newRows.length > 0 && (
          <div className="vlib-new">
            <div className="vlib-new-head">
              <span className="vlib-new-badge">🆕 New vessels detected</span>
              <span className="vlib-new-sub">
                in position lists — review before they’re added to the library.
              </span>
            </div>
            <div className="vessel-grid-wrap">
              <div className="vessel-grid-scroll">
                <table className="vessel-grid vlib-grid">
                  <thead>
                    <tr>
                      <th style={{ width: 46 }}>SR.</th>
                      {COLS.map((c) => (
                        <th key={c.key}>{c.label}</th>
                      ))}
                      <th style={{ width: 120 }}>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {newRows.map((row, i) => (
                      <tr key={row.match_key || i} className="vlib-new-row">
                        <td className="vlib-sr">{i + 1}</td>
                        {COLS.map((c) => (
                          <td key={c.key} className={row[c.key] ? "" : "vlib-blank"}>
                            {row[c.key] || "—"}
                          </td>
                        ))}
                        <td className="vlib-actions">
                          <button
                            type="button"
                            className="tb-btn tb-btn-primary vlib-review-btn"
                            onClick={() =>
                              setModal({ mode: "review", data: { ...BLANK, ...row } })
                            }
                          >
                            Review &amp; add
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {modal && (
        <VesselModal
          mode={modal.mode}
          initial={modal.data}
          saving={saving}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

function LibStat({ label, value }) {
  return (
    <div className="vgrid-stat">
      <span>{label}: </span>
      <b>{value}</b>
    </div>
  );
}

function VesselModal({ mode, initial, saving, onClose, onSave }) {
  const [form, setForm] = useState({ ...BLANK, ...initial });

  const title =
    mode === "edit" ? "Edit vessel" : mode === "review" ? "Review new vessel" : "Add a vessel";

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const submit = (e) => {
    e.preventDefault();
    if (saving) return;
    onSave(COLS.reduce((acc, c) => ({ ...acc, [c.key]: (form[c.key] || "").trim() }), {}));
  };

  return createPortal(
    <div className="vlib-modal-bg" onClick={(e) => e.target.classList.contains("vlib-modal-bg") && onClose()}>
      <form className="vlib-modal" onSubmit={submit}>
        <div className="vlib-modal-head">
          <h3>{title}</h3>
          <button type="button" className="vlib-modal-x" onClick={onClose}>✕</button>
        </div>
        {mode === "review" && (
          <p className="vlib-modal-note">
            Fill in any missing details (like IMO type), then save to add it to your library.
          </p>
        )}
        <div className="vlib-modal-grid">
          {COLS.map((c) => (
            <label key={c.key} className="vlib-field">
              <span>{c.label}</span>
              <input
                value={form[c.key] || ""}
                placeholder={c.ph}
                onChange={(e) => set(c.key, e.target.value)}
                autoFocus={c.key === "vessel_name"}
              />
            </label>
          ))}
        </div>
        <div className="vlib-modal-btns">
          <button type="button" className="tb-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="tb-btn tb-btn-primary" disabled={saving}>
            {saving ? "Saving…" : mode === "edit" ? "Save changes" : "Save to library"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
