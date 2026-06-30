import { useState, useEffect, useCallback, useRef } from "react";
import { getContacts, updateAttachmentContacts } from "../../services/api";

const GRID_BORDER = "1px solid #94a3b8";

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

function EditableContactCell({ value, onSave, placeholder = "—" }) {
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

  const handleSave = useCallback(async (attachmentId, field, value) => {
    setRows((prev) =>
      prev.map((r) =>
        r.attachment_id === attachmentId ? { ...r, [field]: value } : r
      )
    );
    try {
      const payload =
        field === "signature_emails"
          ? { signature_emails: value, signature_phones: undefined }
          : { signature_phones: value, signature_emails: undefined };
      await updateAttachmentContacts(attachmentId, payload);
      flashSaved();
    } catch (e) {
      setError("Failed to save: " + e.message);
      load();
    }
  }, [load]);

  const withEmails = rows.filter((r) => r.signature_emails?.trim()).length;
  const withPhones = rows.filter((r) => r.signature_phones?.trim()).length;

  return (
    <div className="flex flex-col h-full gap-0" style={{ background: "#f0f9ff" }}>
      <div
        className="flex items-center justify-between px-6 py-4 flex-shrink-0 shadow-md"
        style={{ background: "linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%)" }}
      >
        <div>
          <h2 className="text-base font-bold text-white tracking-wide">Contact List</h2>
        </div>
        <span
          className={`text-xs font-semibold transition-all duration-300 ${savedMsg ? "opacity-100" : "opacity-0"}`}
          style={{ color: "#6ee7b7" }}
        >
          ✓ Saved
        </span>
      </div>

      {rows.length > 0 && (
        <div
          className="flex gap-2 px-4 py-2 flex-shrink-0"
          style={{ background: "#e0f2fe", borderBottom: "1px solid #bae6fd" }}
        >
          <Stat label="Attachments" value={rows.length} />
          <Stat label="With emails" value={withEmails} />
          <Stat label="With phones" value={withPhones} />
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
            <div className="text-5xl" style={{ color: "#bae6fd" }}>✉</div>
            <p className="text-sm text-center max-w-md px-4" style={{ color: "#7dd3fc" }}>
              No attachments yet. Fetch emails from the Email Data tab to populate contacts.
            </p>
          </div>
        ) : (
          <table
            className="w-full border-collapse text-left bg-white rounded-lg overflow-hidden shadow-sm"
            style={{ border: GRID_BORDER }}
          >
            <thead>
              <tr style={{ background: "#e0f2fe" }}>
                {[
                  "Date received",
                  "Subject",
                  "Sender",
                  "Attachment",
                  "Broker emails",
                  "Broker phones",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-2 py-2 text-[10px] font-bold uppercase tracking-wide sticky top-0 z-10"
                    style={{
                      color: "#0369a1",
                      borderBottom: GRID_BORDER,
                      borderRight: GRID_BORDER,
                      background: "#e0f2fe",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.attachment_id} className="hover:bg-sky-50/60">
                  <td
                    className="px-2 py-1.5 text-[11px] align-top whitespace-nowrap"
                    style={{ color: "#0c4a6e", borderBottom: GRID_BORDER, borderRight: GRID_BORDER }}
                  >
                    {formatDate(row.date_received)}
                  </td>
                  <td
                    className="px-2 py-1.5 text-[11px] align-top max-w-[200px] break-words"
                    style={{ color: "#0c4a6e", borderBottom: GRID_BORDER, borderRight: GRID_BORDER }}
                    title={row.subject}
                  >
                    {row.subject || "—"}
                  </td>
                  <td
                    className="px-2 py-1.5 text-[11px] align-top max-w-[180px] break-words"
                    style={{ color: "#0c4a6e", borderBottom: GRID_BORDER, borderRight: GRID_BORDER }}
                    title={row.sender}
                  >
                    {row.sender || "—"}
                  </td>
                  <td
                    className="px-2 py-1.5 text-[11px] align-top max-w-[220px] break-words font-medium"
                    style={{ color: "#0369a1", borderBottom: GRID_BORDER, borderRight: GRID_BORDER }}
                    title={row.filename}
                  >
                    {row.filename || "—"}
                  </td>
                  <td
                    className="align-top min-w-[160px] max-w-[280px]"
                    style={{ borderBottom: GRID_BORDER, borderRight: GRID_BORDER }}
                  >
                    <EditableContactCell
                      value={row.signature_emails}
                      onSave={(v) => handleSave(row.attachment_id, "signature_emails", v)}
                    />
                  </td>
                  <td
                    className="align-top min-w-[140px] max-w-[220px]"
                    style={{ borderBottom: GRID_BORDER }}
                  >
                    <EditableContactCell
                      value={row.signature_phones}
                      onSave={(v) => handleSave(row.attachment_id, "signature_phones", v)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {rows.length > 0 && (
        <p className="text-[10px] text-right px-4 py-1 flex-shrink-0" style={{ color: "#7dd3fc" }}>
          Double-click Broker emails or phones to edit. Enter saves · Shift+Enter for new line.
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
