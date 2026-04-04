import { useState } from "react";
import InboxView from "./components/InboxView/InboxView";
import ValidationView from "./components/ValidationView/ValidationView";
import DraftView from "./components/DraftView/DraftView";

const VIEWS = {
  INBOX: "inbox",
  VALIDATION: "validation",
  DRAFT: "draft",
};

export default function App() {
  const [view, setView] = useState(VIEWS.INBOX);
  const [activeEmailId, setActiveEmailId] = useState(null);
  // draftData holds the single consolidated HTML email + zone markers for the map
  const [draftData, setDraftData] = useState({ html: "", zones: [] });

  const goToValidation = (emailId) => {
    setActiveEmailId(emailId);
    setView(VIEWS.VALIDATION);
  };

  const goToDraft = (html, zones) => {
    setDraftData({ html: html || "", zones: zones || [] });
    setView(VIEWS.DRAFT);
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50 overflow-hidden">
      {/* ── Top Nav ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 flex items-center gap-4 px-6 py-3 bg-white border-b border-slate-200 shadow-sm flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xl">⚓</span>
          <span className="font-semibold text-slate-700 text-sm tracking-wide">
            Shipbroking Email Parser
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {[
            { id: VIEWS.INBOX, label: "① Inbox" },
            { id: VIEWS.VALIDATION, label: "② Validate" },
            { id: VIEWS.DRAFT, label: "③ Draft" },
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${
                view === id
                  ? "bg-sky-600 text-white shadow-sm"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {/* ── Main Content ────────────────────────────────────────── */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {view === VIEWS.INBOX && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <InboxView onSendToValidation={goToValidation} />
          </div>
        )}
        {view === VIEWS.VALIDATION && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <ValidationView
              emailId={activeEmailId}
              onDraftGenerated={goToDraft}
            />
          </div>
        )}
        {view === VIEWS.DRAFT && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <DraftView html={draftData.html} zones={draftData.zones} />
          </div>
        )}
      </main>
    </div>
  );
}
