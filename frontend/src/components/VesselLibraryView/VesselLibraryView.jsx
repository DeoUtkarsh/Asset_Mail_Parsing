import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  getVesselLibrary,
  addVesselLibrary,
  updateVesselLibrary,
  deleteVesselLibrary,
} from "../../services/api";
import Icon from "../icons";
import { formatStandardField, parseAiNormalized } from "../../utils/fieldFormat";
import CellHighlightLegend from "../CellHighlightLegend";

const COLS = [
  { key: "vessel_name", label: "Vessel name", ph: "e.g. AMICO PEARL", colClass: "vlib-col-name" },
  { key: "imo_no", label: "IMO no.", ph: "e.g. 9412233", colClass: "vlib-col-imo" },
  { key: "call_sign", label: "Call sign", ph: "e.g. 9V1234", colClass: "vlib-col-call" },
  { key: "vessel_type", label: "Vessel type", ph: "Select vessel type…", colClass: "vlib-col-type" },
  { key: "year_built", label: "Year built", ph: "e.g. 2013", colClass: "vlib-col-year" },
  { key: "imo_type", label: "IMO type", ph: "e.g. IMO II", colClass: "vlib-col-imotype" },
  { key: "dwt", label: "Dead weight (DWT)", ph: "e.g. 74,900", colClass: "vlib-col-dwt" },
  { key: "cbm", label: "CBM / cubic meter", ph: "e.g. 45,000", colClass: "vlib-col-cbm" },
  { key: "flag", label: "Flag", ph: "e.g. Singapore", colClass: "vlib-col-flag" },
  { key: "sire_date", label: "Last SIRE date", ph: "e.g. Jan 2026", colClass: "vlib-col-date" },
  { key: "cdi_date", label: "Last CDI date", ph: "e.g. Mar 2026", colClass: "vlib-col-date" },
];

const VESSEL_TYPE_OPTIONS = [
  "Oil Tanker",
  "Chemical Tanker",
  "Bulk Carrier",
  "Chem/Prod Tanker",
  "Container",
  "LPG Carrier (Refri)",
  "LNG Carrier",
  "Cement Carrier",
  "Asphalt / Bitumen Tanker",
  "LPG Carrier (Press)",
  "Gen Cargo / Multi-Purpose Vessel",
  "Dredger",
  "Offshore Support Vessel",
  "Tug Boat",
  "Others",
];

const BLANK = COLS.reduce((acc, c) => ({ ...acc, [c.key]: "" }), {});

export default function VesselLibraryView({ isActive = false, refreshKey = 0, onLibraryUpdated }) {
  const [rows, setRows] = useState([]);
  const [newRows, setNewRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ key: null, dir: "asc" });
  const [editMode, setEditMode] = useState(false);
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

  const handleVesselTypeChange = async (row, nextType) => {
    const value = String(nextType || "").trim();
    if ((row.vessel_type || "") === value) return;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, vessel_type: value } : r)));
    setError("");
    try {
      await updateVesselLibrary(row.id, { ...row, vessel_type: value });
      flashSaved();
      onLibraryUpdated?.();
    } catch (e) {
      setError("Failed to update vessel type: " + e.message);
      await load();
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
            className={`tb-btn ${editMode ? "tb-btn-primary" : ""}`}
            onClick={() => setEditMode((v) => !v)}
            title={editMode ? "Exit edit mode" : "Highlight missing fields"}
          >
            {editMode ? "Done" : "✎ Edit"}
          </button>
          <button
            type="button"
            className="tb-btn tb-btn-primary"
            onClick={() => setModal({ mode: "add", data: { ...BLANK } })}
          >
            <Icon name="plus" size={15} /> Add a vessel
          </button>
          <CellHighlightLegend />
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
              <table className={`vessel-grid vlib-grid ${editMode ? "vlib-edit-mode" : ""}`}>
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
                          ? "No vessels in the library yet. Fetch emails or click “Add a vessel”."
                          : "No vessels match your search."}
                      </td>
                    </tr>
                  ) : (
                    sorted.map((row, i) => (
                      <tr key={row.id}>
                        <td className="vlib-sr">{i + 1}</td>
                        {COLS.map((c) => {
                          const rawVal = row[c.key];
                          const empty =
                            c.key === "vessel_type"
                              ? !String(rawVal || "").trim() || isImoTypeValue(rawVal)
                              : !String(rawVal || "").trim();
                          const aiNorm =
                            !empty
                            && (c.key === "dwt" || c.key === "dwt_sdwt")
                            && (
                              parseAiNormalized(row.ai_normalized).has("dwt")
                              || parseAiNormalized(row.ai_normalized).has("dwt_sdwt")
                            );
                          return (
                            <td
                              key={c.key}
                              className={[
                                c.colClass || "",
                                empty ? "vlib-blank" : "",
                                editMode && empty ? "vlib-missing" : "",
                                aiNorm ? "vlib-ai-norm" : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                            >
                              {c.key === "vessel_type" ? (
                                <VesselTypeSelect
                                  value={row.vessel_type}
                                  onChange={(val) => handleVesselTypeChange(row, val)}
                                />
                              ) : (
                                formatLibCell(c.key, row[c.key])
                              )}
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
                        <th key={c.key} className={c.colClass || ""}>{c.label}</th>
                      ))}
                      <th style={{ width: 120 }}>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {newRows.map((row, i) => (
                      <tr key={row.match_key || i} className="vlib-new-row">
                        <td className="vlib-sr">{i + 1}</td>
                        {COLS.map((c) => (
                          <td
                            key={c.key}
                            className={[c.colClass || "", row[c.key] ? "" : "vlib-blank"]
                              .filter(Boolean)
                              .join(" ")}
                          >
                            {formatLibCell(c.key, row[c.key])}
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

function formatLibCell(key, value) {
  const formatted = formatStandardField(key, value);
  return formatted || "—";
}

function isImoTypeValue(val) {
  const s = String(val || "").trim();
  if (!s) return false;
  return /^\d+(\/\d+)?$/i.test(s) || /^imo\s*[ivx\d]/i.test(s);
}

function VesselTypeSelect({ value, onChange }) {
  const raw = String(value || "").trim();
  const current = isImoTypeValue(raw) ? "" : raw;
  const known = !current || VESSEL_TYPE_OPTIONS.includes(current);
  const options = [
    { value: "", label: "Select type…" },
    ...(!known && current ? [{ value: current, label: current }] : []),
    ...VESSEL_TYPE_OPTIONS.map((opt) => ({ value: opt, label: opt })),
  ];

  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 220 });

  const placeMenu = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 220);
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    const below = r.bottom + 4;
    const menuH = Math.min(260, options.length * 34 + 12);
    const top =
      below + menuH > window.innerHeight - 8
        ? Math.max(8, r.top - menuH - 4)
        : below;
    setMenuPos({ top, left, width });
  }, [options.length]);

  useEffect(() => {
    if (!open) return undefined;
    placeMenu();
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => placeMenu();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, placeMenu]);

  return (
    <div className="vlib-type-dd">
      <button
        ref={btnRef}
        type="button"
        className={`vlib-type-btn ${current ? "" : "is-empty"} ${open ? "open" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Select vessel type"
      >
        <span className="vlib-type-label">{current || "Select type…"}</span>
        <span className="vlib-type-chev" aria-hidden="true">{open ? "▲" : "▼"}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="vlib-type-menu"
            style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
            role="listbox"
          >
            {options.map((opt) => (
              <button
                key={opt.value || "__empty"}
                type="button"
                role="option"
                aria-selected={opt.value === current}
                className={[
                  "vlib-type-opt",
                  opt.value === current ? "active" : "",
                  !opt.value ? "placeholder" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  onChange(opt.value);
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>,
          document.body
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
    onSave(
      COLS.reduce((acc, c) => {
        const raw = (form[c.key] || "").trim();
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
                  />
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
                  autoFocus={c.key === "vessel_name"}
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
