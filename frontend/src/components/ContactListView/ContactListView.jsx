import { useState, useEffect, useCallback, useRef, useMemo, Fragment, useTransition } from "react";
import { createPortal } from "react-dom";
import { getContacts, updateBrokerContact, uploadOwnersCsv, createBrokerContact, waitForBackend } from "../../services/api";
import Icon from "../icons";
import { downloadContactsCsv } from "../../utils/exportContactsCsv";
import AllColumnsToggle from "../ValidationView/AllColumnsToggle";
import {
  ALL_COLUMNS,
  ALL_CONTACT_COLUMNS,
  buildContactSerialMap,
  buildPinnedOffsets,
  contactCellValue,
  DB_CONTACT_FIELDS,
  DEFAULT_CONTACT_COLUMNS,
  formatContactDisplay,
  patchContactField,
  PINNED_CONTACT_KEYS,
  splitVesselNames,
} from "../../utils/contactColumns";

const DEFAULT_KEYS = new Set(
  DEFAULT_CONTACT_COLUMNS.filter((c) => !c.readOnly && !c.derived).map((c) => c.key),
);

const STATUS_OPTIONS = ["Active", "Inactive"];
const PAGE_SIZE = 50;

function normalizeStatus(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "inactive" || s === "in-active" || s === "in active") return "Inactive";
  return "Active";
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

function companyGroupKey(name) {
  return String(name || "").trim().toLowerCase();
}

function locationParts(row) {
  const city = formatContactDisplay("city", row.city || "");
  const country = formatContactDisplay("country", row.country || "");
  const address = formatContactDisplay("office_address", row.office_address || "");
  const locationLabel = [city, country].filter(Boolean).join(", ");
  return { city, country, address, locationLabel };
}

/** Group by company + location so multi-office companies accordion separately. */
function buildCompanyGroups(rows) {
  const map = new Map();
  for (const row of rows) {
    const ck = companyGroupKey(row.company);
    const { city, country, address, locationLabel } = locationParts(row);
    const locKey = `${city}|${country}|${address}`.toLowerCase();
    const key = `${ck || "__none__"}::${locKey}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        companyKey: ck || "__none__",
        label: ck
          ? formatContactDisplay(
              "company",
              (String(row.company || "").trim()) || "Company",
            )
          : "No company",
        locationLabel,
        address,
        rows: [],
      });
    }
    map.get(key).rows.push(row);
  }

  const named = [];
  let empty = null;
  for (const entry of map.values()) {
    entry.rows.sort((a, b) =>
      String(a.contact_name || "").localeCompare(String(b.contact_name || ""), undefined, {
        sensitivity: "base",
      }),
    );
    if (!entry.locationLabel) {
      const fromRows = locationParts(entry.rows.find((r) => locationParts(r).locationLabel) || {});
      entry.locationLabel = fromRows.locationLabel || "";
    }
    if (!entry.address) {
      entry.address =
        entry.rows.map((r) => locationParts(r).address).find(Boolean) || "";
    }
    if (entry.companyKey === "__none__") empty = entry;
    else named.push(entry);
  }
  named.sort((a, b) => {
    const c = a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    if (c !== 0) return c;
    return (a.locationLabel || "").localeCompare(b.locationLabel || "", undefined, {
      sensitivity: "base",
    });
  });
  if (empty) named.push(empty);
  return named;
}

function StatusSelect({ value, onChange, readOnly = false }) {
  const status = normalizeStatus(value);
  if (readOnly) {
    return (
      <div
        className={`contact-cell contact-status ${status === "Inactive" ? "is-inactive" : "is-active"}`}
        title={status}
      >
        {status}
      </div>
    );
  }
  return (
    <select
      className="contact-status-select"
      value={status}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Contact status"
    >
      {STATUS_OPTIONS.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

function EditableContactCell({
  value,
  onChange,
  placeholder = "—",
  readOnly = false,
  highlightMissing = false,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== (value ?? "").trim()) {
      onChange(next);
    }
  };

  const display = value?.trim() || "";
  const empty = !display;

  if (readOnly) {
    return (
      <div className={`contact-cell ${empty ? "is-empty" : ""}`} title={display}>
        {display || placeholder}
      </div>
    );
  }

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setEditing(true);
          }
        }}
        className={`contact-cell editable ${empty ? "is-empty" : ""} ${
          highlightMissing && empty ? "contact-cell-missing" : ""
        }`}
        title={display || "Click to edit"}
      >
        {display || placeholder}
      </div>
    );
  }

  return (
    <textarea
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setDraft(value ?? "");
          setEditing(false);
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        }
      }}
      rows={2}
      className="contact-cell-edit"
    />
  );
}

function VesselNamesCell({ value, contactName, company }) {
  const vessels = useMemo(() => splitVesselNames(value), [value]);
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      if (!btnRef.current) return;
      const r = btnRef.current.getBoundingClientRect();
      const w = 280;
      let left = r.left;
      if (left + w > window.innerWidth - 12) left = Math.max(12, window.innerWidth - w - 12);
      let top = r.bottom + 6;
      const h = popRef.current?.offsetHeight || 200;
      if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
      setPos({ top, left });
    };
    place();
    const onDoc = (e) => {
      if (
        popRef.current?.contains(e.target)
        || btnRef.current?.contains(e.target)
      ) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!vessels.length) {
    return <div className="contact-cell is-empty">—</div>;
  }

  const first = vessels[0];
  const extra = vessels.length - 1;

  return (
    <div className="contact-vessel-cell">
      <span className="contact-vessel-one" title={first}>
        <Icon name="ship" size={13} />
        {first}
      </span>
      {extra > 0 && (
        <button
          ref={btnRef}
          type="button"
          className="contact-vessel-more"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          aria-expanded={open}
          title={`${extra} more vessel${extra === 1 ? "" : "s"}`}
        >
          +{extra}
        </button>
      )}
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="contact-vessel-pop"
            style={{ top: pos.top, left: pos.left }}
            role="dialog"
            aria-label="Vessel names"
          >
            <div className="contact-vessel-pop-head">
              <div>
                <strong>{contactName || "Contact"}</strong>
                <span>
                  {vessels.length} vessel{vessels.length === 1 ? "" : "s"}
                  {company ? ` · ${company}` : ""}
                </span>
              </div>
              <button type="button" className="contact-vessel-pop-x" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>
            <ul>
              {vessels.map((name) => (
                <li key={name}>
                  <Icon name="ship" size={13} />
                  {name}
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}

function flatExportRows(rows) {
  const out = [];
  for (const group of buildCompanyGroups(rows)) {
    out.push(...group.rows);
  }
  return out;
}

function cellValue(row, key, serialNo) {
  return contactCellValue(row, key, { formatDate, serialNo });
}

function pinnedCellStyle(col, pinnedLeft, isHeader = false, pinIndex = 0) {
  const left = pinnedLeft[col.key];
  if (left == null) {
    return { minWidth: col.minW };
  }
  const z = isHeader ? 80 + pinIndex : 20 + pinIndex;
  return {
    minWidth: col.minW,
    maxWidth: col.minW,
    width: col.minW,
    position: "sticky",
    left,
    zIndex: z,
    boxShadow: col.pinEdge ? "4px 0 6px -2px rgba(16,24,40,.1)" : undefined,
  };
}

function pinIndexFor(colKey) {
  const i = PINNED_CONTACT_KEYS.indexOf(colKey);
  return i >= 0 ? i : 0;
}

function withNormalizedStatus(rows) {
  return (rows || []).map((r) => ({ ...r, status: normalizeStatus(r.status) }));
}

export default function ContactListView({ isActive = false, refreshKey = 0 }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(Boolean(isActive));
  const [error, setError] = useState("");
  const [savedMsg, setSavedMsg] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [columnsPending, startColumnsTransition] = useTransition();
  const [csvUploading, setCsvUploading] = useState(false);
  const [countryFilter, setCountryFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const savedTimer = useRef(null);
  const csvInputRef = useRef(null);
  const rowsRef = useRef([]);
  const editSnapshot = useRef(null);
  const dirtyRef = useRef(new Set());

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const flashSaved = () => {
    setSavedMsg(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedMsg(false), 2000);
  };

  const load = useCallback(async () => {
    const firstPaint = rowsRef.current.length === 0;
    if (firstPaint) setLoading(true);
    setError("");
    try {
      const data = await getContacts();
      const normalized = withNormalizedStatus(data);
      setRows(normalized);
      rowsRef.current = normalized;
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    (async () => {
      await waitForBackend();
      load();
    })();
  }, [isActive, refreshKey, load]);

  const enterEditMode = useCallback(() => {
    editSnapshot.current = rowsRef.current.map((r) => ({ ...r }));
    dirtyRef.current = new Set();
    setError("");
    setEditMode(true);
  }, []);

  const cancelEditMode = useCallback(() => {
    if (editSnapshot.current) {
      setRows(editSnapshot.current);
      rowsRef.current = editSnapshot.current;
    }
    dirtyRef.current = new Set();
    setEditMode(false);
  }, []);

  const handleCellChange = useCallback(
    (contactId, field, value) => {
      if (!editMode) return;
      const next = rowsRef.current.map((r) =>
        r.contact_id === contactId ? patchContactField(r, field, value) : r
      );
      rowsRef.current = next;
      setRows(next);
      dirtyRef.current.add(contactId);
    },
    [editMode]
  );

  const handleSaveEdits = useCallback(async () => {
    const ids = [...dirtyRef.current];
    if (ids.length === 0) {
      setEditMode(false);
      return;
    }
    setEditSaving(true);
    setError("");
    try {
      await Promise.all(
        ids.map((id) => {
          const row = rowsRef.current.find((r) => r.contact_id === id);
          if (!row) return null;
          const fields = {};
          for (const key of DB_CONTACT_FIELDS) {
            fields[key] = row[key] ?? "";
          }
          return updateBrokerContact(id, fields);
        })
      );
      dirtyRef.current = new Set();
      editSnapshot.current = null;
      setEditMode(false);
      flashSaved();
      await load();
    } catch (e) {
      setError("Failed to save: " + e.message);
    } finally {
      setEditSaving(false);
    }
  }, [load]);

  const countryOptions = useMemo(() => {
    const set = new Set();
    for (const row of rows) {
      const country = String(row.country || "").trim();
      if (country) set.add(country);
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [rows]);

  const visibleColumns = useMemo(
    () => (showAllColumns ? ALL_COLUMNS : DEFAULT_CONTACT_COLUMNS),
    [showAllColumns],
  );
  const visibleKeySet = useMemo(
    () => new Set(visibleColumns.map((col) => col.key)),
    [visibleColumns],
  );

  const filteredRows = useMemo(() => {
    let list = rows;
    if (countryFilter) {
      const want = countryFilter.trim().toLowerCase();
      list = list.filter((row) => String(row.country || "").trim().toLowerCase() === want);
    }
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((row) =>
      visibleColumns.some((col) => {
        const raw = cellValue(row, col.key, null);
        return String(raw || "").toLowerCase().includes(q);
      })
      || String(row.company || "").toLowerCase().includes(q)
      || String(row.office_address || "").toLowerCase().includes(q)
      || String(row.city || "").toLowerCase().includes(q)
      || String(row.country || "").toLowerCase().includes(q)
    );
  }, [rows, countryFilter, search, visibleColumns]);

  useEffect(() => {
    setPage(1);
  }, [countryFilter, search, showAllColumns]);

  const pinnedLeft = useMemo(() => buildPinnedOffsets(visibleColumns), [visibleColumns]);
  const companyGroups = useMemo(() => buildCompanyGroups(filteredRows), [filteredRows]);
  const serialMap = useMemo(
    () => buildContactSerialMap(filteredRows, buildCompanyGroups),
    [filteredRows],
  );
  const highlightKeys = showAllColumns
    ? new Set(ALL_CONTACT_COLUMNS.filter((c) => !c.readOnly).map((c) => c.key))
    : DEFAULT_KEYS;

  const locationCount = useMemo(
    () => new Set(companyGroups.map((g) => g.key)).size,
    [companyGroups],
  );
  const companyCount = useMemo(
    () => new Set(companyGroups.map((g) => g.companyKey)).size,
    [companyGroups],
  );

  const pagedGroups = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(companyGroups.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * PAGE_SIZE;
    const slice = companyGroups.slice(start, start + PAGE_SIZE);
    return {
      groups: slice,
      totalGroups: companyGroups.length,
      totalContacts: filteredRows.length,
      totalPages,
      page: safePage,
    };
  }, [companyGroups, page, filteredRows.length]);

  const pageKeys = useMemo(
    () => pagedGroups.groups.map((g) => g.key),
    [pagedGroups.groups],
  );
  const expandedOnPage = pageKeys.filter((k) => expanded.has(k)).length;

  const toggleGroup = (key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const expandAll = () => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const k of pageKeys) next.add(k);
      return next;
    });
  };

  const collapseAll = () => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const k of pageKeys) next.delete(k);
      return next;
    });
  };

  const handleAllColumnsToggle = useCallback((next) => {
    startColumnsTransition(() => setShowAllColumns(next));
  }, []);

  const handleExportCsv = () => {
    downloadContactsCsv(flatExportRows(filteredRows), visibleColumns, formatDate, () => serialMap);
  };

  const handleAddContact = async (fields) => {
    setAddSaving(true);
    setError("");
    try {
      await createBrokerContact(fields);
      setAddOpen(false);
      flashSaved();
      await load();
    } catch (e) {
      setError(e.message || "Could not add contact.");
    } finally {
      setAddSaving(false);
    }
  };

  const handleOwnersCsv = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setCsvUploading(true);
    setError("");
    try {
      await uploadOwnersCsv(file);
      flashSaved();
      await load();
    } catch (e) {
      setError(e.message || "File upload failed");
    } finally {
      setCsvUploading(false);
    }
  };

  const colSpan = ALL_COLUMNS.length;

  return (
    <div className="vgrid-root">
      <div className="vgrid-head">
        <div className="vgrid-title">
          <h2>Contact List</h2>
          <span className="vgrid-sub">
            Broker contacts from emails, grouped by company
          </span>
        </div>
        <div className="vgrid-actions">
          <span className={`vgrid-saved ${savedMsg ? "show" : ""}`}>✓ Saved</span>

          <button
            type="button"
            onClick={handleExportCsv}
            disabled={loading || filteredRows.length === 0}
            className="tb-btn"
            title="Download contacts as CSV"
          >
            Export CSV
          </button>

          <button
            type="button"
            className="tb-btn tb-btn-primary"
            disabled={editMode || addSaving}
            onClick={() => setAddOpen(true)}
          >
            <Icon name="plus" size={15} /> Add contact
          </button>
        </div>
      </div>

      <div className="contact-toolbar">
        <div className="lp-search contact-search contact-search-wide">
          <Icon name="search" size={15} />
          <input
            placeholder="Search name, company, email, phone or vessel"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {countryOptions.length > 0 && (
          <select
            className="vf-input vf-select contact-country-select"
            value={countryFilter}
            onChange={(e) => setCountryFilter(e.target.value)}
            aria-label="Filter contacts by country"
          >
            <option value="">All countries</option>
            {countryOptions.map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </select>
        )}
      </div>

      {rows.length > 0 && (
        <div className="contact-acc-bar">
          <div className="contact-acc-stats">
            <span><b>{filteredRows.length}</b> contacts</span>
            <span>
              <b>{companyCount}</b> companies
              {locationCount !== companyCount ? ` in ${locationCount} locations` : ""}
            </span>
          </div>
          <div className="contact-acc-controls">
            <button type="button" className="contact-acc-link" onClick={expandAll} disabled={!pageKeys.length}>
              Expand all
            </button>
            <button type="button" className="contact-acc-link" onClick={collapseAll} disabled={!pageKeys.length}>
              Collapse all
            </button>
            <span className="contact-acc-meta">
              {expandedOnPage} of {pageKeys.length} expanded
            </span>
          </div>
          <div className="contact-acc-actions">
            {!loading && rows.length > 0 && (
              editMode ? (
                <>
                  <button
                    type="button"
                    className="btn-save-changes"
                    onClick={handleSaveEdits}
                    disabled={editSaving}
                  >
                    {editSaving ? (
                      <>
                        <span className="spin-ring" /> Saving…
                      </>
                    ) : (
                      "Save changes"
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn-cancel-edit"
                    onClick={cancelEditMode}
                    disabled={editSaving}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn-edit"
                  onClick={enterEditMode}
                  title="Edit contact fields"
                >
                  ✎ Edit
                </button>
              )
            )}
            {!loading && rows.length > 0 && (
              <AllColumnsToggle
                enabled={showAllColumns}
                onChange={handleAllColumnsToggle}
                visibleCount={DEFAULT_CONTACT_COLUMNS.length}
                totalCount={ALL_COLUMNS.length}
              />
            )}
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,.json,.pdf,.xlsx,.xls,.xlsm,text/csv,application/pdf,application/json,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              hidden
              onChange={handleOwnersCsv}
            />
            <button
              type="button"
              onClick={() => csvInputRef.current?.click()}
              disabled={csvUploading || editMode}
              className="tb-btn"
              title="Upload CSV, Excel, JSON, or PDF into contacts"
            >
              {csvUploading ? (
                <>
                  <span className="spin-ring" /> Uploading…
                </>
              ) : (
                "Upload file"
              )}
            </button>
          </div>
        </div>
      )}

      {error && <div className="vgrid-err">{error}</div>}

      <div className="vgrid-body">
        {loading ? (
          <div className="center-load">
            <span className="spin-ring" /> Loading contacts…
          </div>
        ) : rows.length === 0 ? (
          <div className="vessel-grid-empty">
            {error
              ? "Could not load contacts. Wait a moment and click Retry, or refresh once the backend is up."
              : "No contacts yet. Fetch emails on Vessel Extracted Data — contacts are extracted automatically after vessel extraction and signature parsing."}
            {error ? (
              <button type="button" className="tb-btn" style={{ marginTop: 12 }} onClick={() => load()}>
                Retry
              </button>
            ) : null}
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="vessel-grid-empty">
            {(countryFilter || search)
              ? "No contacts match this search or country filter."
              : "No contacts to show."}
            <button
              type="button"
              className="tb-btn"
              style={{ marginTop: 12 }}
              onClick={() => {
                setCountryFilter("");
                setSearch("");
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="vessel-grid-wrap">
            {editMode && (
              <p className="contact-edit-hint">Click a cell to edit, then Save changes</p>
            )}
            <div className={`vessel-grid-scroll ${columnsPending ? "is-columns-pending" : ""}`}>
              <table className="vessel-grid contact-grid contact-grid-acc">
                <colgroup>
                  {ALL_COLUMNS.map((col) => (
                    <col
                      key={col.key}
                      span={1}
                      style={{
                        width: col.minW,
                        minWidth: col.minW,
                        ...(visibleKeySet.has(col.key) ? {} : { display: "none" }),
                      }}
                    />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    {ALL_COLUMNS.map((col) => {
                      const hidden = !visibleKeySet.has(col.key);
                      const label =
                        visibleColumns.find((c) => c.key === col.key)?.label ?? col.label;
                      return (
                        <th
                          key={col.key}
                          className={[
                            hidden ? "contact-col-hidden" : "",
                            PINNED_CONTACT_KEYS.includes(col.key) ? "contact-pin-col" : "",
                            col.pinEdge ? "contact-pin-edge" : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined}
                          style={pinnedCellStyle(col, pinnedLeft, true, pinIndexFor(col.key))}
                          title={label}
                          aria-hidden={hidden || undefined}
                        >
                          <span className="contact-th-label">{label}</span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {pagedGroups.groups.map((group) => {
                    const isOpen = expanded.has(group.key);
                    return (
                      <Fragment key={group.key}>
                        <tr className={`contact-acc-row${isOpen ? " is-open" : ""}`}>
                          <td colSpan={colSpan}>
                            <button
                              type="button"
                              className="contact-acc-toggle"
                              onClick={() => toggleGroup(group.key)}
                              aria-expanded={isOpen}
                            >
                              <span className={`contact-acc-chevron${isOpen ? " open" : ""}`}>▸</span>
                              <span className="contact-acc-main">
                                <span className="contact-acc-title-line">
                                  <strong className="contact-acc-company">{group.label}</strong>
                                  {group.locationLabel ? (
                                    <span className="contact-acc-loc">{group.locationLabel}</span>
                                  ) : null}
                                  {group.address ? (
                                    <span className="contact-acc-addr-inline">
                                      · {group.address}
                                    </span>
                                  ) : null}
                                </span>
                              </span>
                              <span className="contact-acc-count">
                                {group.rows.length} contact{group.rows.length === 1 ? "" : "s"}
                              </span>
                            </button>
                          </td>
                        </tr>
                        {isOpen &&
                          group.rows.map((row) => (
                            <tr
                              key={row.contact_id}
                              className={[
                                "contact-data-row",
                                row.used_fallback ? "contact-fallback" : "",
                              ]
                                .filter(Boolean)
                                .join(" ") || undefined}
                            >
                              {ALL_COLUMNS.map((col) => {
                                const hidden = !visibleKeySet.has(col.key);
                                const serialNo = serialMap.get(row.contact_id);
                                const raw = cellValue(row, col.key, serialNo);
                                const isPinned = PINNED_CONTACT_KEYS.includes(col.key);
                                const isEditable = editMode && !col.readOnly;
                                const highlightMissing =
                                  editMode &&
                                  !col.readOnly &&
                                  highlightKeys.has(col.key) &&
                                  !(raw || "").trim();
                                return (
                                  <td
                                    key={col.key}
                                    style={{
                                      ...pinnedCellStyle(
                                        col,
                                        pinnedLeft,
                                        false,
                                        pinIndexFor(col.key),
                                      ),
                                      ...(!isPinned
                                        ? {
                                            maxWidth:
                                              col.key === "status"
                                                ? 140
                                                : col.readOnly
                                                  ? 220
                                                  : 280,
                                          }
                                        : {}),
                                    }}
                                    className={[
                                      hidden ? "contact-col-hidden" : "",
                                      highlightMissing ? "cell-missing" : "",
                                      isPinned ? "contact-pin-col" : "",
                                      col.pinEdge ? "contact-pin-edge" : "",
                                    ]
                                      .filter(Boolean)
                                      .join(" ") || undefined}
                                    aria-hidden={hidden || undefined}
                                  >
                                    {hidden ? null : col.type === "status" ? (
                                      <StatusSelect
                                        value={raw}
                                        readOnly={!isEditable}
                                        onChange={(v) =>
                                          handleCellChange(row.contact_id, "status", v)
                                        }
                                      />
                                    ) : col.key === "vessel_name" && !isEditable ? (
                                      <VesselNamesCell
                                        value={raw}
                                        contactName={row.contact_name}
                                        company={group.label}
                                      />
                                    ) : isEditable ? (
                                      <EditableContactCell
                                        value={raw}
                                        readOnly={false}
                                        highlightMissing={highlightMissing}
                                        onChange={(v) =>
                                          handleCellChange(row.contact_id, col.key, v)
                                        }
                                      />
                                    ) : (
                                      <div
                                        className={[
                                          "contact-cell cell-val",
                                          String(raw || "").trim() ? "" : "is-empty",
                                        ]
                                          .filter(Boolean)
                                          .join(" ")}
                                        title={String(raw || "")}
                                      >
                                        {String(raw || "").trim() || "—"}
                                      </div>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {rows.length > 0 && !editMode && (
        <p className="contact-hint">
          Expand a company to see contacts · Click Edit to change fields
        </p>
      )}

      {pagedGroups.totalPages > 1 && (
        <div className="list-pager">
          <button
            type="button"
            className="tb-btn"
            disabled={pagedGroups.page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span>
            Page {pagedGroups.page} of {pagedGroups.totalPages} · {pagedGroups.totalGroups}{" "}
            locations · {pagedGroups.totalContacts} contacts
          </span>
          <button
            type="button"
            className="tb-btn"
            disabled={pagedGroups.page >= pagedGroups.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}

      {addOpen && (
        <AddContactModal
          saving={addSaving}
          onClose={() => setAddOpen(false)}
          onSave={handleAddContact}
        />
      )}
    </div>
  );
}

function AddContactModal({ saving, onClose, onSave }) {
  const [form, setForm] = useState({
    contact_name: "",
    company: "",
    email: "",
    off_phone: "",
    mob_phone: "",
    office_address: "",
    country: "",
    city: "",
    trade: "",
    role: "",
    website_address: "",
    other_info: "",
    status: "Active",
  });
  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));
  const submit = (e) => {
    e.preventDefault();
    if (saving) return;
    onSave(form);
  };
  return createPortal(
    <div className="vlib-modal-bg" onClick={(e) => e.target.classList.contains("vlib-modal-bg") && onClose()}>
      <form className="vlib-modal" onSubmit={submit}>
        <div className="vlib-modal-head">
          <h3>Add contact</h3>
          <button type="button" className="vlib-modal-x" onClick={onClose}>✕</button>
        </div>
        <p className="vlib-modal-note" style={{ padding: "12px 20px 0" }}>
          Manual contacts are saved to the Contact List.
        </p>
        <div className="vlib-modal-grid">
          {[
            ["contact_name", "PIC name"],
            ["company", "Company"],
            ["email", "Email"],
            ["off_phone", "Telephone"],
            ["mob_phone", "Mobile"],
            ["office_address", "Office address"],
            ["country", "Country"],
            ["city", "City"],
            ["trade", "Owners / operators"],
            ["role", "Role"],
            ["website_address", "Website"],
            ["other_info", "Remarks"],
          ].map(([key, label]) => (
            <label key={key} className="vlib-field">
              <span>{label}</span>
              <input value={form[key] || ""} onChange={(e) => set(key, e.target.value)} />
            </label>
          ))}
          <label className="vlib-field">
            <span>Status</span>
            <select className="vlib-select" value={form.status} onChange={(e) => set("status", e.target.value)}>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </label>
        </div>
        <div className="vlib-modal-btns">
          <button type="button" className="tb-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="tb-btn tb-btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Save contact"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
