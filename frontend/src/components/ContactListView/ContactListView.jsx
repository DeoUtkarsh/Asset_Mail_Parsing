import { useState, useEffect, useCallback, useRef, useMemo, Fragment, useTransition } from "react";
import { getContacts, updateBrokerContact, uploadOwnersCsv } from "../../services/api";
import { downloadContactsCsv } from "../../utils/exportContactsCsv";
import CellHighlightLegend from "../CellHighlightLegend";
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
} from "../../utils/contactColumns";

const DEFAULT_KEYS = new Set(
  DEFAULT_CONTACT_COLUMNS.filter((c) => !c.readOnly && !c.derived).map((c) => c.key),
);

const STATUS_OPTIONS = ["Active", "Inactive"];

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

function buildCompanyGroups(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = companyGroupKey(row.company);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }

  const named = [];
  let empty = null;
  for (const [key, groupRows] of map.entries()) {
    groupRows.sort((a, b) =>
      String(a.contact_name || "").localeCompare(String(b.contact_name || ""), undefined, {
        sensitivity: "base",
      }),
    );
    const label = key
      ? formatContactDisplay(
          "company",
          (groupRows.find((r) => String(r.company || "").trim())?.company || "").trim(),
        )
      : "No company";
    const entry = { key: key || "__none__", label, rows: groupRows };
    if (!key) empty = entry;
    else named.push(entry);
  }
  named.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
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

function isOwnersListRow(row) {
  const src = String(row?.source || "").toLowerCase();
  if (src === "owners-list") return true;
  if (src === "email" || src === "mixed") return false;
  const excel = row?.excel_sourced;
  return Array.isArray(excel) && excel.length > 0 && src !== "email";
}

function buildSourceSections(rows) {
  const fromEmail = [];
  const fromExcel = [];
  for (const row of rows) {
    if (isOwnersListRow(row)) fromExcel.push(row);
    else fromEmail.push(row);
  }
  return [
    {
      key: "email",
      label: "Email contacts",
      groups: buildCompanyGroups(fromEmail),
      count: fromEmail.length,
    },
    {
      key: "owners-list",
      label: "Owners directory",
      groups: buildCompanyGroups(fromExcel),
      count: fromExcel.length,
    },
  ].filter((section) => section.count > 0);
}

function cellValue(row, key, serialNo) {
  return contactCellValue(row, key, { formatDate, serialNo });
}

function flatExportRows(rows) {
  const sections = buildSourceSections(rows);
  const out = [];
  for (const section of sections) {
    for (const group of section.groups) {
      out.push(...group.rows);
    }
  }
  return out;
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

function groupHeaderStickyStyle(pinnedTotalWidth) {
  return {
    position: "sticky",
    left: 0,
    zIndex: 31,
    width: pinnedTotalWidth,
    minWidth: pinnedTotalWidth,
    maxWidth: pinnedTotalWidth,
    overflow: "hidden",
  };
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
    if (isActive) load();
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

  const filteredRows = useMemo(() => {
    if (!countryFilter) return rows;
    const want = countryFilter.trim().toLowerCase();
    return rows.filter((row) => String(row.country || "").trim().toLowerCase() === want);
  }, [rows, countryFilter]);

  const filteredWithEmail = filteredRows.filter((r) => r.email?.trim()).length;
  const filteredWithName = filteredRows.filter((r) => r.contact_name?.trim()).length;
  const filteredFallbackRows = filteredRows.filter((r) => r.used_fallback).length;
  const visibleColumns = useMemo(
    () => (showAllColumns ? ALL_COLUMNS : DEFAULT_CONTACT_COLUMNS),
    [showAllColumns],
  );
  const visibleKeySet = useMemo(
    () => new Set(visibleColumns.map((col) => col.key)),
    [visibleColumns],
  );
  const pinnedLeft = useMemo(() => buildPinnedOffsets(visibleColumns), [visibleColumns]);
  const pinnedVisibleColumns = useMemo(
    () => visibleColumns.filter((col) => PINNED_CONTACT_KEYS.includes(col.key)),
    [visibleColumns],
  );
  const pinnedColCount = pinnedVisibleColumns.length;
  const scrollColCount = visibleColumns.length - pinnedColCount;
  const pinnedTotalWidth = useMemo(
    () => pinnedVisibleColumns.reduce((sum, col) => sum + col.minW, 0),
    [pinnedVisibleColumns],
  );
  const groupHeaderSticky = useMemo(
    () => groupHeaderStickyStyle(pinnedTotalWidth),
    [pinnedTotalWidth],
  );
  const serialMap = useMemo(
    () => buildContactSerialMap(filteredRows, buildSourceSections),
    [filteredRows],
  );
  const highlightKeys = showAllColumns
    ? new Set(ALL_CONTACT_COLUMNS.filter((c) => !c.readOnly).map((c) => c.key))
    : DEFAULT_KEYS;
  const sourceSections = useMemo(() => buildSourceSections(filteredRows), [filteredRows]);
  const emailCount = filteredRows.filter((r) => !isOwnersListRow(r)).length;

  const handleAllColumnsToggle = useCallback((next) => {
    startColumnsTransition(() => setShowAllColumns(next));
  }, []);

  const handleExportCsv = () => {
    downloadContactsCsv(flatExportRows(filteredRows), visibleColumns, formatDate, () => serialMap);
  };

  const handleOwnersCsv = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setCsvUploading(true);
    setError("");
    try {
      const result = await uploadOwnersCsv(file);
      flashSaved();
      await load();
      if (result?.inserted != null) {
        setError("");
      }
    } catch (e) {
      setError(e.message || "Owners file upload failed");
    } finally {
      setCsvUploading(false);
    }
  };

  return (
    <div className="vgrid-root">
      <div className="vgrid-head">
        <div className="vgrid-title">
          <h2>Contact List</h2>
          <span className="vgrid-sub">
            Broker contacts from emails and the imported owners directory
          </span>
        </div>
        <div className="vgrid-actions">
          <span className={`vgrid-saved ${savedMsg ? "show" : ""}`}>✓ Saved</span>

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

          <CellHighlightLegend
            className="contact-legends"
            variant="contacts"
            showMissing={editMode}
          />

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
            title="Upload CSV, Excel, JSON, or PDF into Owners directory. Email contacts stay separate."
          >
            {csvUploading ? (
              <>
                <span className="spin-ring" /> Extracting owners…
              </>
            ) : (
              "Upload owners file"
            )}
          </button>

          <button
            type="button"
            onClick={handleExportCsv}
            disabled={loading || rows.length === 0}
            className="tb-btn"
            title="Download all contacts as CSV (same columns as this table)"
          >
            Export CSV
          </button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="vgrid-stats">
          <ContactStat label="Contacts" value={filteredRows.length} />
          <ContactStat label="Email contacts" value={emailCount} />
          <ContactStat label="Owners directory" value={filteredRows.length - emailCount} />
          <ContactStat label="With name" value={filteredWithName} />
          <ContactStat label="With email" value={filteredWithEmail} />
          {filteredFallbackRows > 0 && (
            <ContactStat label="Fallback rows" value={filteredFallbackRows} />
          )}
          {countryFilter && filteredRows.length !== rows.length && (
            <ContactStat label="Total (all countries)" value={rows.length} />
          )}
        </div>
      )}

      {rows.length > 0 && countryOptions.length > 0 && (
        <div className="vgrid-filters">
          <div className="vf-group">
            <span className="vf-label">Country</span>
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
          </div>
          {countryFilter ? (
            <button
              type="button"
              className="tb-btn vf-clear"
              onClick={() => setCountryFilter("")}
            >
              Clear country filter
            </button>
          ) : null}
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
            {`No contacts in ${countryFilter}. Try another country or clear the filter.`}
            <button
              type="button"
              className="tb-btn"
              style={{ marginTop: 12 }}
              onClick={() => setCountryFilter("")}
            >
              Clear country filter
            </button>
          </div>
        ) : (
          <div className="vessel-grid-wrap">
            {editMode && (
              <p className="contact-edit-hint">Click a cell to edit, then Save changes</p>
            )}
            <div className={`vessel-grid-scroll ${columnsPending ? "is-columns-pending" : ""}`}>
              <table className="vessel-grid contact-grid">
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
                    );})}
                  </tr>
                </thead>
                <tbody>
                  {sourceSections.map((section) => (
                    <Fragment key={section.key}>
                      <tr
                        className={`contact-section-row ${section.key === "owners-list" ? "is-excel" : "is-email"}`}
                      >
                        <td colSpan={pinnedColCount || 1} style={groupHeaderSticky}>
                          <span className="contact-section-label">{section.label}</span>
                        </td>
                        {scrollColCount > 0 ? <td colSpan={scrollColCount} /> : null}
                      </tr>
                      {section.groups.map((group) => (
                    <Fragment key={`${section.key}-${group.key}`}>
                      <tr className="grp-row contact-company-heading">
                        <td colSpan={pinnedColCount || 1} style={groupHeaderSticky}>
                          <span className="grp-label contact-company-heading-label">
                            {group.label}
                          </span>
                        </td>
                        {scrollColCount > 0 ? <td colSpan={scrollColCount} /> : null}
                      </tr>
                      {group.rows.map((row) => (
                    <tr
                      key={row.contact_id}
                      className={[
                        "contact-data-row",
                        row.used_fallback ? "contact-fallback" : "",
                        section.key === "owners-list" ? "contact-excel-row" : "",
                      ].filter(Boolean).join(" ") || undefined}
                    >
                      {ALL_COLUMNS.map((col) => {
                        const hidden = !visibleKeySet.has(col.key);
                        const serialNo = serialMap.get(row.contact_id);
                        const raw = cellValue(row, col.key, serialNo);
                        const isPinned = PINNED_CONTACT_KEYS.includes(col.key);
                        const isEditable = editMode && !col.readOnly && col.key !== "_sno";
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
                                      col.key === "status" ? 140 : col.readOnly ? 220 : 280,
                                  }
                                : {}),
                            }}
                            className={[
                              hidden ? "contact-col-hidden" : "",
                              highlightMissing ? "cell-missing" : "",
                              isPinned ? "contact-pin-col" : "",
                              col.pinEdge ? "contact-pin-edge" : "",
                              col.companyCol ? "contact-col-company" : "",
                              section.key === "owners-list" && isPinned
                                ? "contact-pin-excel"
                                : "",
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
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {rows.length > 0 && !editMode && (
        <p className="contact-hint">
          Click Edit to change fields · Highlighted rows = signature fallback
        </p>
      )}
    </div>
  );
}

function ContactStat({ label, value }) {
  return (
    <div className="vgrid-stat">
      <span>{label}: </span>
      <b>{value}</b>
    </div>
  );
}
