import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  getVesselLibrary,
  addVesselLibrary,
  updateVesselLibrary,
  deleteVesselLibrary,
  autofillVesselLibrary,
} from "../../services/api";
import Icon from "../icons";
import { formatStandardField } from "../../utils/fieldFormat";
import VesselTypeSelect, {
  isImoTypeValue,
} from "../VesselTypeSelect";

const COLS = [
  { key: "vessel_name", label: "VESSEL NAME", ph: "e.g. AMICO PEARL", colClass: "vlib-col-name" },
  { key: "imo_no", label: "IMO NO.", ph: "e.g. 9412233", colClass: "vlib-col-imo" },
  { key: "call_sign", label: "CALL SIGN", ph: "e.g. 9V1234", colClass: "vlib-col-call" },
  { key: "vessel_type", label: "VESSEL TYPE", ph: "Select vessel type…", colClass: "vlib-col-type" },
  { key: "year_built", label: "YEAR BUILT", ph: "e.g. 2013", colClass: "vlib-col-year" },
  { key: "imo_type", label: "IMO TYPE", ph: "e.g. IMO II", colClass: "vlib-col-imotype" },
  { key: "dwt", label: "DEAD WEIGHT (DWT)", ph: "e.g. 74,900", colClass: "vlib-col-dwt" },
  { key: "cbm", label: "CBM / CUBIC METER", ph: "e.g. 45,000", colClass: "vlib-col-cbm" },
  { key: "flag", label: "FLAG", ph: "e.g. Singapore", colClass: "vlib-col-flag" },
  { key: "sire_date", label: "LAST SIRE DATE", ph: "e.g. Jan 2026", colClass: "vlib-col-date" },
  { key: "cdi_date", label: "LAST CDI DATE", ph: "e.g. Mar 2026", colClass: "vlib-col-date" },
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
  const [reviewAllSaving, setReviewAllSaving] = useState(false);
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
    setSort({ key: null, dir: "asc" });
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
    const numericKeys = new Set(["dwt", "year_built", "imo_no", "cbm"]);
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

  const handleReviewAll = async () => {
    const n = newRows.length;
    if (!n || reviewAllSaving) return;
    if (
      !window.confirm(
        `Add all ${n} new vessel${n === 1 ? "" : "s"} to the library now?\n\nYou can still edit any vessel later.`
      )
    ) {
      return;
    }
    setReviewAllSaving(true);
    setError("");
    try {
      const stats = await autofillVesselLibrary();
      flashSaved();
      await load();
      onLibraryUpdated?.();
      const inserted = stats?.inserted ?? n;
      window.alert(
        inserted > 0
          ? `Added ${inserted} vessel${inserted === 1 ? "" : "s"} to the library.`
          : "No new vessels were added (they may already be in the library)."
      );
    } catch (e) {
      setError("Review all failed: " + e.message);
    } finally {
      setReviewAllSaving(false);
    }
  };

  const nameSuggestions = useMemo(() => {
    const set = new Set();
    for (const r of rows) {
      const n = String(r.vessel_name || "").trim();
      if (n) set.add(n);
    }
    for (const r of newRows) {
      const n = String(r.vessel_name || "").trim();
      if (n) set.add(n);
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [rows, newRows]);

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

      {(rows.length > 0 || newRows.length > 0) && (
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
          <>
          {!loading && newRows.length > 0 && (
          <div className="vlib-new" style={{ marginBottom: 14 }}>
            <div className="vlib-new-head">
              <div className="vlib-new-head-text">
                <span className="vlib-new-badge">New vessels to review</span>
                <span className="vlib-new-sub">
                  Found in fetched position lists — add only the ones you want, or add all at once.
                </span>
              </div>
              <button
                type="button"
                className="tb-btn tb-btn-primary vlib-review-all-btn"
                onClick={handleReviewAll}
                disabled={reviewAllSaving}
                title="Add every new vessel to the library without reviewing one by one"
              >
                {reviewAllSaving
                  ? "Adding…"
                  : `Review all (${newRows.length})`}
              </button>
            </div>
            <div className="vessel-grid-wrap">
              <div className="vessel-grid-scroll">
                <table className="vessel-grid vlib-grid">
                  <thead>
                    <tr>
                      <th style={{ width: 46 }}>SR.</th>
                      {COLS.map((c) => (
                        <th key={c.key} className={c.colClass || ""}>{c.label}</th>
                      ))}
                      <th style={{ width: 120 }}>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {newRows.map((row, i) => (
                      <tr key={row.match_key || i} className="vlib-new-row">
                        <td className="vlib-sr">{i + 1}</td>
                        {COLS.map((c) => {
                          const rawVal = row[c.key];
                          const display =
                            c.key === "vessel_type"
                              ? (isImoTypeValue(rawVal) ? "" : String(rawVal || "").trim())
                              : formatLibCell(c.key, rawVal);
                          const empty = !display || display === "—";
                          return (
                            <td
                              key={c.key}
                              className={[c.colClass || "", empty ? "vlib-blank" : ""]
                                .filter(Boolean)
                                .join(" ")}
                            >
                              {empty ? "—" : display}
                            </td>
                          );
                        })}
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
                          className={`vlib-th-sort ${c.colClass || ""}`}
                          onClick={() => toggleSort(c.key)}
                          title={`Sort by ${c.label}`}
                        >
                          <span className="vlib-th-inner">
                            {c.label}
                            <span className={`vlib-sort-ic ${active ? "on" : ""}`}>
                              {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
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
                          ? (newRows.length > 0
                            ? "Library is empty. Review & add vessels from the list above, or click “Add a vessel”."
                            : "No vessels in the library yet. Fetch emails, then Review & add — or click “Add a vessel”.")
                          : "No vessels match your search."}
                      </td>
                    </tr>
                  ) : (
                    sorted.map((row, i) => (
                      <tr key={row.id}>
                        <td className="vlib-sr">{i + 1}</td>
                        {COLS.map((c) => {
                          const rawVal = row[c.key];
                          const display =
                            c.key === "vessel_type"
                              ? (isImoTypeValue(rawVal) ? "" : String(rawVal || "").trim())
                              : formatLibCell(c.key, rawVal);
                          const empty = !display || display === "—";
                          return (
                            <td
                              key={c.key}
                              className={[c.colClass || "", empty ? "vlib-blank" : ""]
                                .filter(Boolean)
                                .join(" ")}
                            >
                              {empty ? "—" : display}
                            </td>
                          );
                        })}
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
          </>
        )}
      </div>

      {modal && (
        <VesselModal
          mode={modal.mode}
          initial={modal.data}
          saving={saving}
          nameSuggestions={nameSuggestions}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

function formatLibCell(key, value) {
  const formatted = formatStandardField(key, value);
  return formatted || "—";
}

function LibStat({ label, value }) {
  return (
    <div className="vgrid-stat">
      <span>{label}: </span>
      <b>{value}</b>
    </div>
  );
}

function VesselModal({ mode, initial, saving, nameSuggestions = [], onClose, onSave }) {
  const [form, setForm] = useState({ ...BLANK, ...initial });
  const nameListId = "vlib-vessel-name-suggestions";

  const title =
    mode === "edit" ? "Edit vessel" : mode === "review" ? "Review new vessel" : "Add a vessel";

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const submit = (e) => {
    e.preventDefault();
    if (saving) return;
    onSave(
      COLS.reduce((acc, c) => {
        let raw = (form[c.key] || "").trim();
        if (c.key === "vessel_type") {
          if (raw === "Others" || isImoTypeValue(raw)) raw = "";
        }
        acc[c.key] = formatStandardField(c.key, raw) || raw;
        return acc;
      }, {})
    );
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
          {COLS.map((c) => {
            if (c.key === "vessel_type") {
              return (
                <label key={c.key} className="vlib-field">
                  <span>{c.label}</span>
                  <VesselTypeSelect
                    value={form.vessel_type}
                    onChange={(val) => set(c.key, val)}
                    fieldSize
                  />
                </label>
              );
            }
            if (c.key === "vessel_name") {
              return (
                <label key={c.key} className="vlib-field">
                  <span>{c.label}</span>
                  <input
                    list={nameListId}
                    value={form.vessel_name || ""}
                    placeholder="Pick a suggestion or type any name"
                    onChange={(e) => set(c.key, e.target.value)}
                    autoFocus
                  />
                  <datalist id={nameListId}>
                    {nameSuggestions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </label>
              );
            }
            return (
              <label key={c.key} className="vlib-field">
                <span>{c.label}</span>
                <input
                  value={form[c.key] || ""}
                  placeholder={c.ph}
                  onChange={(e) => set(c.key, e.target.value)}
                />
              </label>
            );
          })}
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
