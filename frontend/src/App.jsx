import { useState } from "react";
import InboxView from "./components/InboxView/InboxView";
import ValidationView from "./components/ValidationView/ValidationView";
import ContactListView from "./components/ContactListView/ContactListView";

const VIEWS = {
  INBOX: "inbox",
  VALIDATION: "validation",
  DRAFT: "draft",
};

export default function App() {
  const [view, setView] = useState(VIEWS.VALIDATION);
  const [draftEmailId, setDraftEmailId] = useState(null);
  const [vesselRefreshKey, setVesselRefreshKey] = useState(0);
  const [contactRefreshKey, setContactRefreshKey] = useState(0);

  const setEmailForDraft = (emailId) => {
    setDraftEmailId(emailId);
  };

  const refreshVesselList = () => {
    setVesselRefreshKey((k) => k + 1);
  };

  const refreshContactList = () => {
    setContactRefreshKey((k) => k + 1);
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50 overflow-hidden">
      {/* ── Top Nav ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 flex items-center gap-4 px-6 py-3 bg-white border-b border-slate-200 shadow-sm flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xl">⚓</span>
          <span className="font-semibold text-slate-700 text-sm tracking-wide">
            Email Extraction Agent
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {[
            { id: VIEWS.VALIDATION, label: "Vessel Position List" },
            { id: VIEWS.INBOX, label: "Email Extraction Inbox" },
            { id: VIEWS.DRAFT, label: "Contact List" },
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

      {/* ── Main Content — keep all tabs mounted so state/SSE survive tab switches ── */}
      <main className="flex-1 overflow-hidden flex flex-col relative">
        <div
          className={`flex-1 min-h-0 overflow-hidden ${view === VIEWS.INBOX ? "" : "hidden"}`}
        >
          <InboxView
            onEmailReady={setEmailForDraft}
            onVesselsUpdated={refreshVesselList}
            onContactsUpdated={refreshContactList}
          />
        </div>
        <div
          className={`flex-1 min-h-0 overflow-hidden ${view === VIEWS.VALIDATION ? "" : "hidden"}`}
        >
          <ValidationView
            draftEmailId={draftEmailId}
            refreshKey={vesselRefreshKey}
            isActive={view === VIEWS.VALIDATION}
          />
        </div>
        <div
          className={`flex-1 min-h-0 overflow-hidden ${view === VIEWS.DRAFT ? "" : "hidden"}`}
        >
          <ContactListView
            isActive={view === VIEWS.DRAFT}
            refreshKey={contactRefreshKey}
          />
        </div>
      </main>
    </div>
  );
}
