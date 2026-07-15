import { useState, useEffect, useCallback, useRef } from "react";
import { getContacts, updateBrokerContact, summarizeContacts } from "../../services/api";
import AiSummaryButton from "../AiSummary/AiSummaryButton";
import { downloadContactsCsv } from "../../utils/exportContactsCsv";

const CONTEXT_COLUMNS = [
  { key: "date_received", label: "Date received", readOnly: true, minW: 120 },
  { key: "subject", label: "Subject", readOnly: true, minW: 160 },
  { key: "sender", label: "Sender", readOnly: true, minW: 140 },
  { key: "filename", label: "Attachment", readOnly: true, minW: 160 },
];

const CONTACT_COLUMNS = [
  { key: "contact_name", label: "Contact name", minW: 120 },
  { key: "designation", label: "Designation", minW: 110 },
  { key: "department", label: "Department", minW: 110 },
  { key: "company", label: "Company", minW: 130 },
  { key: "company_type", label: "Company type", minW: 100 },
  { key: "vessel_name", label: "Vessel name", minW: 120 },
  { key: "email", label: "Email", minW: 150 },
  { key: "off_phone", label: "Off phone", minW: 120 },
  { key: "mob_phone", label: "Mob phone", minW: 120 },
  { key: "wechat", label: "WeChat", minW: 90 },
  { key: "whatsapp", label: "WhatsApp", minW: 100 },
  { key: "website_address", label: "Website", minW: 120 },
  { key: "office_address", label: "Office address", minW: 160 },
  { key: "other_info", label: "Other info", minW: 120 },
  { key: "status", label: "Status", minW: 80 },
];

const ALL_COLUMNS = [...CONTEXT_COLUMNS, ...CONTACT_COLUMNS];

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

function EditableContactCell({ value, onSave, placeholder = "—", readOnly = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== (value ?? "").trim()) {
      onSave(next);
    }
  };

  if (readOnly) {
    const display = value?.trim() || "";
    return (
      <div className={`contact-cell ${display ? "" : "is-empty"}`} title={display}>
        {display || placeholder}
      </div>
    );
  }

  if (!editing) {
    const display = value?.trim() || "";
    return (
      <div
        onDoubleClick={() => setEditing(true)}
        className={`contact-cell editable ${display ? "" : "is-empty"}`}
        title={display || "Double-click to edit"}
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
  return row[key] ?? "";
}

export default function ContactListView({ isActive = false, refreshKey = 0 }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savedMsg, setSavedMsg] = useState(false);
  const savedTimer = useRef(null);

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
      setRows(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isActive) load();
  }, [isActive, refreshKey, load]);

  const handleSave = useCallback(
    async (contactId, field, value) => {
      setRows((prev) =>
        prev.map((r) => (r.contact_id === contactId ? { ...r, [field]: value } : r))
      );
      try {
        await updateBrokerContact(contactId, { [field]: value });
        flashSaved();
      } catch (e) {
        setError("Failed to save: " + e.message);
        load();
      }
    },
    [load]
  );

  const withEmail = rows.filter((r) => r.email?.trim()).length;
  const withName = rows.filter((r) => r.contact_name?.trim()).length;
  const fallbackRows = rows.filter((r) => r.used_fallback).length;

  const fetchContactSummary = useCallback(
    () => summarizeContacts(rows.map((r) => r.contact_id)),
    [rows],
  );

  const handleExportCsv = () => {
    downloadContactsCsv(rows, ALL_COLUMNS, formatDate);
  };

  return (
    <div className="vgrid-root">

      <div className="vgrid-head">
        <h2>Contact List</h2>
        <div className="vgrid-actions">
          <span className={`vgrid-saved ${savedMsg ? "show" : ""}`}>✓ Saved</span>
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={loading || rows.length === 0}
            className="tb-btn"
            title="Download all contacts as CSV (same columns as this table)"
          >
            Export CSV
          </button>
          <AiSummaryButton
            fetchSummary={fetchContactSummary}
            title="Contact List — AI Summary"
            disabled={loading || rows.length === 0}
            className="tb-btn"
          />
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
          <div className="center-load"><span className="spin-ring" /> Loading contacts…</div>
        ) : rows.length === 0 ? (
          <div className="vessel-grid-empty">
            No contacts yet. Fetch emails on Vessel Extracted Data — contacts are extracted
            automatically after vessel extraction and signature parsing.
          </div>
        ) : (
          <div className="vessel-grid-wrap">
            <div className="vessel-grid-scroll">
              <table className="vessel-grid contact-grid">
                <thead>
                  <tr>
                    {ALL_COLUMNS.map((col) => (
                      <th key={col.key} style={{ minWidth: col.minW }}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.contact_id} className={row.used_fallback ? "contact-fallback" : undefined}>
                      {ALL_COLUMNS.map((col) => (
                        <td key={col.key} style={{ minWidth: col.minW, maxWidth: col.readOnly ? 220 : 280 }}>
                          <EditableContactCell
                            value={cellValue(row, col.key)}
                            readOnly={col.readOnly}
                            onSave={(v) => handleSave(row.contact_id, col.key, v)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <p className="contact-hint">
          Double-click contact fields to edit · Enter saves · Shift+Enter for new line · Highlighted rows = signature fallback
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
