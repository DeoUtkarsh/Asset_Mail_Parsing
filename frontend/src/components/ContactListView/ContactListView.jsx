import { useState, useEffect, useCallback, useRef } from "react";
import { getContacts, updateBrokerContact, summarizeContacts } from "../../services/api";
import AiSummaryButton from "../AiSummary/AiSummaryButton";

const GRID_BORDER = "1px solid #94a3b8";

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
      <div
        className="px-2 py-1.5 min-h-[28px] text-[11px] leading-snug whitespace-pre-wrap break-words"
        style={{ color: display ? "#0c4a6e" : "#94a3b8", fontStyle: display ? "normal" : "italic" }}
        title={display}
      >
        {display || placeholder}
      </div>
    );
  }

  if (!editing) {
    const display = value?.trim() || "";
    return (
      <div
        onDoubleClick={() => setEditing(true)}
        className="px-2 py-1.5 min-h-[28px] text-[11px] leading-snug whitespace-pre-wrap break-words cursor-text"
        style={{
          color: display ? "#0c4a6e" : "#94a3b8",
          fontStyle: display ? "normal" : "italic",
        }}
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
      className="w-full px-2 py-1 text-[11px] leading-snug resize-y min-h-[28px]"
      style={{ border: "1px solid #38bdf8", outline: "none", color: "#0c4a6e" }}
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

  return (
    <div className="flex flex-col h-full gap-0" style={{ background: "#f0f9ff" }}>
      <div
        className="flex items-center justify-between px-6 py-4 flex-shrink-0 shadow-md"
        style={{ background: "linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%)" }}
      >
        <div>
          <h2 className="text-base font-bold text-white tracking-wide">Contact List</h2>
        </div>
        <div className="flex items-center gap-2">
          <AiSummaryButton
            fetchSummary={fetchContactSummary}
            title="Contact List — AI Summary"
            disabled={loading || rows.length === 0}
          />
          <span
            className={`text-xs font-semibold transition-all duration-300 ${savedMsg ? "opacity-100" : "opacity-0"}`}
            style={{ color: "#6ee7b7" }}
          >
            ✓ Saved
          </span>
        </div>
      </div>

      {rows.length > 0 && (
        <div
          className="flex gap-2 px-4 py-2 flex-shrink-0 flex-wrap"
          style={{ background: "#e0f2fe", borderBottom: "1px solid #bae6fd" }}
        >
          <Stat label="Contacts" value={rows.length} />
          <Stat label="With name" value={withName} />
          <Stat label="With email" value={withEmail} />
          {fallbackRows > 0 && <Stat label="Fallback rows" value={fallbackRows} />}
        </div>
      )}

      {error && (
        <div
          className="flex-shrink-0 mx-6 mt-3 px-4 py-2 rounded-lg text-sm"
          style={{ background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626" }}
        >
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
        {loading ? (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: "#7dd3fc" }}>
            <span className="inline-block w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin mr-2" />
            Loading contacts…
          </div>
        ) : rows.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-4 rounded-xl border-dashed m-6 h-[calc(100%-3rem)]"
            style={{ background: "#fff", border: "2px dashed #bae6fd" }}
          >
            <div className="text-5xl" style={{ color: "#bae6fd" }}>
              ✉
            </div>
            <p className="text-sm text-center max-w-md px-4" style={{ color: "#7dd3fc" }}>
              No contacts yet. Fetch emails on the Email Data tab — contacts are extracted
              automatically after vessel extraction and signature parsing.
            </p>
          </div>
        ) : (
          <table
            className="border-collapse text-left bg-white rounded-lg overflow-hidden shadow-sm"
            style={{ border: GRID_BORDER, minWidth: "100%" }}
          >
            <thead>
              <tr style={{ background: "#e0f2fe" }}>
                {ALL_COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className="px-2 py-2 text-[10px] font-bold uppercase tracking-wide sticky top-0 z-10"
                    style={{
                      color: "#0369a1",
                      borderBottom: GRID_BORDER,
                      borderRight: GRID_BORDER,
                      background: "#e0f2fe",
                      minWidth: col.minW,
                    }}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.contact_id}
                  className="hover:bg-sky-50/60"
                  style={row.used_fallback ? { background: "#fffbeb" } : undefined}
                >
                  {ALL_COLUMNS.map((col, colIdx) => (
                    <td
                      key={col.key}
                      className="align-top"
                      style={{
                        borderBottom: GRID_BORDER,
                        borderRight: colIdx < ALL_COLUMNS.length - 1 ? GRID_BORDER : undefined,
                        minWidth: col.minW,
                        maxWidth: col.readOnly ? 220 : 280,
                      }}
                    >
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
        )}
      </div>

      {rows.length > 0 && (
        <p className="text-[10px] text-right px-4 py-1 flex-shrink-0" style={{ color: "#7dd3fc" }}>
          Double-click contact fields to edit · Enter saves · Shift+Enter for new line · Yellow rows =
          signature fallback
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div
      className="px-2 py-1 rounded-md text-[11px] shadow-sm"
      style={{ background: "#fff", border: "1px solid #bae6fd" }}
    >
      <span style={{ color: "#7dd3fc" }}>{label}: </span>
      <span className="font-bold" style={{ color: "#0369a1" }}>
        {value}
      </span>
    </div>
  );
}
