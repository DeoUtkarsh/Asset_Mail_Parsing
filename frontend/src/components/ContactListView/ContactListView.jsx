import { useState, useEffect, useCallback, useRef } from "react";
import { getContacts, updateBrokerContact } from "../../services/api";
import { downloadContactsCsv } from "../../utils/exportContactsCsv";
import CellHighlightLegend from "../CellHighlightLegend";

const CONTEXT_COLUMNS = [
  { key: "date_received", label: "Date received", readOnly: true, minW: 120 },
  { key: "subject", label: "Subject", readOnly: true, minW: 160 },
  { key: "sender", label: "Sender", readOnly: true, minW: 140 },
  { key: "filename", label: "Attachment", readOnly: true, minW: 160 },
];

/** Default summary contact columns (All columns off). */
const SUMMARY_CONTACT_COLUMNS = [
  { key: "contact_name", label: "Contact name", minW: 120 },
  { key: "designation", label: "Designation", minW: 110 },
  { key: "department", label: "Department", minW: 110 },
  { key: "company", label: "Company", minW: 130 },
  { key: "company_type", label: "Company type", minW: 100 },
  { key: "vessel_name", label: "Vessel name", minW: 120 },
  { key: "email", label: "Email", minW: 150 },
  { key: "off_phone", label: "Off phone", minW: 120 },
  { key: "mob_phone", label: "Mob phone", minW: 120 },
];

const EXTRA_CONTACT_COLUMNS = [
  { key: "wechat", label: "WeChat", minW: 90 },
  { key: "whatsapp", label: "WhatsApp", minW: 100 },
  { key: "website_address", label: "Website", minW: 120 },
  { key: "office_address", label: "Office address", minW: 160 },
  { key: "other_info", label: "Other info", minW: 120 },
  { key: "status", label: "Status", minW: 110, type: "status" },
];

const ALL_CONTACT_COLUMNS = [...SUMMARY_CONTACT_COLUMNS, ...EXTRA_CONTACT_COLUMNS];
const ALL_COLUMNS = [...CONTEXT_COLUMNS, ...ALL_CONTACT_COLUMNS];
const SUMMARY_KEYS = new Set(SUMMARY_CONTACT_COLUMNS.map((c) => c.key));

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

function cellValue(row, key) {
  if (key === "date_received") return formatDate(row.date_received);
  if (key === "status") return normalizeStatus(row.status);
  return row[key] ?? "";
}

function withNormalizedStatus(rows) {
  return (rows || []).map((r) => ({ ...r, status: normalizeStatus(r.status) }));
}

export default function ContactListView({ isActive = false, refreshKey = 0 }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savedMsg, setSavedMsg] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const savedTimer = useRef(null);
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
    setLoading(true);
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
        r.contact_id === contactId ? { ...r, [field]: value } : r
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
          for (const col of ALL_CONTACT_COLUMNS) {
            fields[col.key] = row[col.key] ?? "";
          }
          return updateBrokerContact(id, fields);
        })
      );
      dirtyRef.current = new Set();
      editSnapshot.current = null;
      setEditMode(false);
      flashSaved();
    } catch (e) {
      setError("Failed to save: " + e.message);
    } finally {
      setEditSaving(false);
    }
  }, []);

  const withEmail = rows.filter((r) => r.email?.trim()).length;
  const withName = rows.filter((r) => r.contact_name?.trim()).length;
  const fallbackRows = rows.filter((r) => r.used_fallback).length;

  const handleExportCsv = () => {
    downloadContactsCsv(rows, ALL_COLUMNS, formatDate);
  };

  return (
    <div className="vgrid-root">
      <div className="vgrid-head">
        <h2>Contact List</h2>
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

          {editMode && <CellHighlightLegend className="contact-legends" />}

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
          <ContactStat label="Contacts" value={rows.length} />
          <ContactStat label="With name" value={withName} />
          <ContactStat label="With email" value={withEmail} />
          {fallbackRows > 0 && <ContactStat label="Fallback rows" value={fallbackRows} />}
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
            No contacts yet. Fetch emails on Vessel Extracted Data — contacts are extracted
            automatically after vessel extraction and signature parsing.
          </div>
        ) : (
          <div className="vessel-grid-wrap">
            {editMode && (
              <p className="contact-edit-hint">Click a cell to edit, then Save changes</p>
            )}
            <div className="vessel-grid-scroll">
              <table className="vessel-grid contact-grid">
                <thead>
                  <tr>
                    {ALL_COLUMNS.map((col) => (
                      <th key={col.key} style={{ minWidth: col.minW }}>
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.contact_id}
                      className={row.used_fallback ? "contact-fallback" : undefined}
                    >
                      {ALL_COLUMNS.map((col) => {
                        const raw = cellValue(row, col.key);
                        const isEditable = editMode && !col.readOnly;
                        const highlightMissing =
                          editMode &&
                          !col.readOnly &&
                          SUMMARY_KEYS.has(col.key) &&
                          !(raw || "").trim();
                        return (
                          <td
                            key={col.key}
                            style={{
                              minWidth: col.minW,
                              maxWidth: col.key === "status" ? 140 : col.readOnly ? 220 : 280,
                            }}
                            className={highlightMissing ? "cell-missing" : undefined}
                          >
                            {col.type === "status" ? (
                              <StatusSelect
                                value={raw}
                                readOnly={!isEditable}
                                onChange={(v) =>
                                  handleCellChange(row.contact_id, "status", v)
                                }
                              />
                            ) : (
                              <EditableContactCell
                                value={raw}
                                readOnly={!isEditable}
                                highlightMissing={highlightMissing}
                                onChange={(v) =>
                                  handleCellChange(row.contact_id, col.key, v)
                                }
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {rows.length > 0 && !editMode && (
        <p className="contact-hint">
          Click Edit to change contact fields · Highlighted rows = signature fallback
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
