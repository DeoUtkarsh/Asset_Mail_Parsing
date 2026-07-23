import { useState, useEffect, useCallback, useRef } from "react";
import { getEmails, getAllVessels, updateVessel, fetchEmails, generateDraft, getAttachments, getColumns, getHomeSummary } from "./services/api";
import { useSSE } from "./hooks/useSSE";
import { needsReview, confidencePct, confBand, byAttachment, deriveEmail, parseFromName, STD_COLUMNS } from "./lib/positions";
import ValidationView from "./components/ValidationView/ValidationView";
import InboxView from "./components/InboxView/InboxView";
import HomeView from "./components/HomeView/HomeView";
import ContactListView from "./components/ContactListView/ContactListView";
import VesselLibraryView from "./components/VesselLibraryView/VesselLibraryView";
import LoginView from "./components/Login/LoginView";
import EmailDetail from "./components/pages/EmailDetail";
import AiSummaryButton from "./components/AiSummary/AiSummaryButton";
import Icon from "./components/icons";
import { summarizeInbox } from "./services/api";

const FILTER_SENDER = "sanjib@iconshipbrokers.com";
const RAIL = [
  { id: "home", ic: "home", label: "Home" },
  { id: "inbox", ic: "grid", label: "Vessel Extracted Data" },
  { id: "review", ic: "alert", label: "Need to Review" },
  { id: "today", ic: "anchor", label: "Vessel Position List" },
  { id: "list", ic: "users", label: "Contact List" },
  { id: "library", ic: "library", label: "Vessel Libraries List" },
];
const ST = {
  auto: ["st-auto", "✓ auto"],
  review: ["st-rev", "⚠ review"],
  processing: ["st-proc", "⟳ parsing"],
  error: ["st-err", "✕ error"],
};
const AV_COLORS = ["#219495", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#10b981", "#ec4899", "#0ea5e9"];

function countNeedsReviewFromEmails(emails) {
  let n = 0;
  for (const em of emails || []) {
    for (const att of em.attachments || []) {
      if (att.needs_review) n += 1;
    }
  }
  return n;
}

const AUTH_KEY = "bs_auth";

export default function App() {
  const [authed, setAuthed] = useState(() => {
    try { return localStorage.getItem(AUTH_KEY) === "1"; } catch { return false; }
  });

  const handleLogin = useCallback(() => {
    try { localStorage.setItem(AUTH_KEY, "1"); } catch { /* ignore */ }
    setAuthed(true);
  }, []);

  const handleLogout = useCallback(() => {
    try { localStorage.removeItem(AUTH_KEY); } catch { /* ignore */ }
    setAuthed(false);
  }, []);

  if (!authed) return <LoginView onLogin={handleLogin} />;
  return <MainApp onLogout={handleLogout} />;
}

function MainApp({ onLogout }) {
  const [view, setView] = useState("home");
  const [emails, setEmails] = useState([]);
  const [activeEmailId, setActiveEmailId] = useState(null);
  const [vessels, setVessels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedAttId, setSelectedAttId] = useState(null);
  const [attRaw, setAttRaw] = useState({});
  const [query, setQuery] = useState("");

  const [draft, setDraft] = useState({ html: "", zones: [] });
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftStale, setDraftStale] = useState(true);
  const [allColumns, setAllColumns] = useState([]);        // superset of extracted keys
  const [draftColumns, setDraftColumns] = useState(STD_COLUMNS); // chosen columns for the email

  const [syncing, setSyncing] = useState(false);
  const [fetchJob, setFetchJob] = useState(null);
  const [draftJob, setDraftJob] = useState(null);

  const [sendModal, setSendModal] = useState(false);
  const [vesselRefreshKey, setVesselRefreshKey] = useState(0);
  const [contactRefreshKey, setContactRefreshKey] = useState(0);
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  const [homeSummary, setHomeSummary] = useState(null);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState("");
  const homeLoadedKey = useRef(-1);
  const [toastMsg, setToastMsg] = useState(null);
  const toastTimer = useRef(null);
  const toast = useCallback((m) => { setToastMsg(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastMsg(null), 2400); }, []);

  // ── Data ──
  const loadVessels = useCallback(async (emailId) => {
    if (!emailId) return;
    const [v, cols] = await Promise.all([
      getAllVessels(emailId),
      getColumns(emailId).catch(() => ({ columns: [] })),
    ]);
    setVessels(v);
    setAllColumns(cols.columns || []);
    setDraftStale(true);
  }, []);
  const loadEmails = useCallback(async () => {
    const data = await getEmails();
    setEmails(data);
    const active = data.find((e) => (e.attachments || []).length > 0) || data[0];
    if (active) {
      setActiveEmailId(active.id);
      await loadVessels(active.id);
      try {
        const atts = await getAttachments(active.id);
        setAttRaw(Object.fromEntries(atts.map((a) => [a.id, a.raw_text || ""])));
      } catch { /* raw text is best-effort */ }
    } else { setActiveEmailId(null); setVessels([]); }
  }, [loadVessels]);
  useEffect(() => { (async () => { try { await loadEmails(); } finally { setLoading(false); } })(); }, [loadEmails]);

  // ── Sync (fetch) ──
  const onSync = async () => {
    setSyncing(true);
    try { const { job_id } = await fetchEmails(); setFetchJob(job_id); }
    catch (e) { setSyncing(false); toast("Fetch failed: " + e.message); }
  };
  useSSE(fetchJob, useCallback((evt) => {
    if (evt.type === "phase1_complete") { setSyncing(false); setFetchJob(null); loadEmails(); setHomeRefreshKey((k) => k + 1); setLibraryRefreshKey((k) => k + 1); toast("Synced — owner emails updated"); }
    else if (evt.type === "phase1_failed") { setSyncing(false); setFetchJob(null); toast("Fetch failed: " + (evt.error || "unknown")); }
  }, [loadEmails, toast]));

  // ── Draft ──
  const runDraft = useCallback(async () => {
    if (!activeEmailId || vessels.length === 0) return;
    setDraftLoading(true);
    const payload = vessels.map((v) => ({ id: v.id, dynamic_data: v.dynamic_data, region: v.region, attachment_id: v.attachment_id, filename: v.filename }));
    try { const { job_id } = await generateDraft(activeEmailId, payload, draftColumns); setDraftJob(job_id); }
    catch (e) { setDraftLoading(false); toast("Could not build list: " + e.message); }
  }, [activeEmailId, vessels, draftColumns, toast]);
  useSSE(draftJob, useCallback((evt) => {
    if (evt.type === "drafting_done") { setDraft({ html: evt.draft_html || "", zones: evt.zones || [] }); setDraftStale(false); setDraftLoading(false); setDraftJob(null); }
    else if (evt.type === "phase2_failed") { setDraftLoading(false); setDraftJob(null); toast("Draft failed: " + (evt.error || "unknown")); }
  }, [toast]));
  useEffect(() => { if (vessels.length && draftStale && !draftLoading && !draft.html) runDraft(); }, [vessels, draftStale, draftLoading, draft.html, runDraft]);

  // ── Confirm ──
  const onConfirm = useCallback(async (v, region) => {
    const newRegion = region || v.region || "";
    setVessels((prev) => prev.map((x) => x.id === v.id ? { ...x, region: newRegion, is_validated: true } : x));
    setDraftStale(true);
    try { await updateVessel(v.id, v.dynamic_data, newRegion, true); } catch (e) { toast("Save failed: " + e.message); }
  }, [toast]);
  const onConfirmAll = useCallback(async (list) => {
    const ids = new Set(list.map((v) => v.id));
    setVessels((prev) => prev.map((x) => ids.has(x.id) ? { ...x, is_validated: true } : x));
    setDraftStale(true);
    await Promise.all(list.map((v) => updateVessel(v.id, v.dynamic_data, v.region || "", true).catch(() => {})));
    toast("All positions confirmed");
  }, [toast]);

  // ── Nav ──
  const go = useCallback((v) => {
    setView(v);
  }, []);

  const onVerifiedChange = useCallback(async () => {
    await loadEmails();
    if (activeEmailId) await loadVessels(activeEmailId);
    setVesselRefreshKey((k) => k + 1);
    setHomeRefreshKey((k) => k + 1);
    setLibraryRefreshKey((k) => k + 1);
  }, [loadEmails, loadVessels, activeEmailId]);

  const inboxSummary = useCallback(
    () => summarizeInbox(emails.map((e) => e.id)),
    [emails],
  );

  // Home summary is cached in App so switching tabs doesn't re-fetch.
  // It reloads only when homeRefreshKey changes (real data change) or via manual refresh.
  const loadHome = useCallback(async () => {
    setHomeLoading(true);
    setHomeError("");
    const keyAtStart = homeRefreshKey;
    try {
      const res = await getHomeSummary();
      setHomeSummary(res);
      homeLoadedKey.current = keyAtStart;
    } catch (e) {
      setHomeError(e.message || "Failed to load summary.");
    } finally {
      setHomeLoading(false);
    }
  }, [homeRefreshKey]);

  // Keep Home review count in sync with the inbox list (avoids stale "1 to check").
  const syncHomeIfReviewCountChanged = useCallback((emailData) => {
    const live = countNeedsReviewFromEmails(emailData);
    const cached = homeSummary?.facts?.review_count;
    if (cached != null && cached !== live) {
      setHomeRefreshKey((k) => k + 1);
    }
  }, [homeSummary?.facts?.review_count]);

  useEffect(() => {
    if (view === "home" && homeLoadedKey.current !== homeRefreshKey && !homeLoading) {
      loadHome();
    }
  }, [view, homeRefreshKey, homeLoading, loadHome]);

  const onCopy = () => {
    const tmp = document.createElement("div"); tmp.innerHTML = draft.html;
    navigator.clipboard?.writeText(tmp.innerText || draft.html).catch(() => {});
    toast("✔ Copied — paste into your email client");
  };

  // ── Derived ──
  const activeEmail = emails.find((e) => e.id === activeEmailId);
  const attachments = activeEmail?.attachments || [];
  const senderName = activeEmail?.sender || FILTER_SENDER;
  const flagged = vessels.filter(needsReview);
  const need = flagged.length;
  const positions = vessels.length;
  const zonesCount = draft.zones?.length || 0;
  const readiness = confidencePct(vessels);
  const hasData = positions > 0;

  const posByAtt = new Map(byAttachment(vessels).map((g) => [g.attachment_id, g]));
  const emailRows = attachments.map((a) => {
    const g = posByAtt.get(a.id); const vs = g?.vessels || []; const fl = g?.flagged || 0;
    const status = a.status === "error" ? "error" : (a.status !== "done") ? "processing" : fl > 0 ? "review" : a.is_verified ? "auto" : "review";
    const em = deriveEmail(attRaw[a.id]);
    const files = a.files || [];
    const sender = parseFromName(a.mail_from) || em.sender;
    const subject = a.mail_subject || em.subject;
    const pct = a.confidence_score != null ? a.confidence_score : (vs.length ? confidencePct(vs) : 100);
    const band = a.confidence_tier === "high" ? "hi" : a.confidence_tier === "medium" ? "mid" : a.confidence_tier === "low" ? "lo" : confBand(pct);
    return {
      id: a.id, filename: a.filename, sender, subject, snippet: em.snippet,
      files, hasAttachment: files.length > 0 || em.hasAttachment,
      mailDate: a.mail_date, count: a.vessel_count ?? vs.length, flagged: fl, status,
      pct, band, isVerified: Boolean(a.is_verified),
      confidenceLabel: a.confidence_label,
    };
  });
  const fmtMailDate = (s, fallback) => {
    if (!s) return fallback;
    const d = new Date(s);
    return isNaN(d) ? fallback : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  };
  const emailDate = activeEmail?.date_received
    ? new Date(activeEmail.date_received).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
    : "";
  const listRows = emailRows
    .filter((r) => view === "review" ? r.status === "review" : true)
    .filter((r) => !query || r.filename.toLowerCase().includes(query.toLowerCase()));

  // auto-select first row when browsing emails
  useEffect(() => {
    if ((view === "inbox" || view === "review") && listRows.length) {
      if (!selectedAttId || !listRows.some((r) => r.id === selectedAttId)) setSelectedAttId(listRows[0].id);
    }
  }, [view, listRows, selectedAttId]);

  const selectEmail = (id) => { setSelectedAttId(id); };
  const selectedAtt = attachments.find((a) => a.id === selectedAttId);
  const selRow = emailRows.find((r) => r.id === selectedAttId);
  const selectedPositions = vessels.filter((v) => v.attachment_id === selectedAttId);

  const showLeft = false;

  return (
    <div className="app-shell">
      {/* ── Top header ── */}
      <header className="topbar">
        <div className="logo">
          <img className="mark" src="/logo.png?v=2" alt="Broker Sense" />
          <div className="wm"><span className="l1">BROKER</span><span className="l2">SENSE</span></div>
        </div>
        <div className="tb-right">
          <button type="button" className="tb-logout" onClick={onLogout}>
            <Icon name="logout" size={16} /> Logout
          </button>
        </div>
      </header>

      <div className="appbody">
      <div className="panels">
      {/* ── Rail ── */}
      <div className="rail">
        {RAIL.map((n) => (
          <button key={n.id} className={`ricon ${view === n.id ? "active" : ""}`} onClick={() => go(n.id)}>
            <Icon name={n.ic} size={21} />
            <span className="ricon-tip">{n.label}</span>
          </button>
        ))}
        <div className="rspacer" />
      </div>

      {/* ── Left list panel ── */}
      {showLeft && (
        <div className="lpanel">
          <div className="lpanel-head">
            <div className="lh-top">
              <h2>{view === "review" ? "Review" : "Inbox"}</h2>
              <span className="lh-count">({listRows.length})</span>
              {view === "inbox" && (
                <AiSummaryButton
                  fetchSummary={inboxSummary}
                  title="Email Extraction Inbox — AI Summary"
                  disabled={loading || emails.length === 0}
                  className="lh-btn"
                />
              )}
              {view === "review" && need > 0 && (
                <button className="lh-btn" onClick={() => onConfirmAll(flagged)}>✓ Confirm all {need}</button>
              )}
            </div>
            <p>{view === "review" ? "Emails with positions that need a quick check." : "Owner position emails, parsed automatically."}</p>
            <div className="lp-search"><Icon name="search" size={16} /> <input placeholder="Search file…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          </div>
          <div className="lpanel-list">
            {loading ? (
              <div className="li-empty"><span className="spin-ring" /> Loading…</div>
            ) : listRows.length === 0 ? (
              <div className="li-empty">{view === "review" ? "Nothing to review 🎉" : "No emails yet. Hit Sync."}</div>
            ) : listRows.map((r) => {
              const [sc, sl] = ST[r.status]; const band = r.band || confBand(r.pct);
              return (
                <div key={r.id} className={`gmrow ${selectedAttId === r.id ? "active" : ""} ${r.status === "review" ? "flag" : ""}`} onClick={() => selectEmail(r.id)}>
                  <div className="gm-avatar" style={{ background: AV_COLORS[r.sender.charCodeAt(0) % AV_COLORS.length] }}>{r.sender[0]?.toUpperCase() || "•"}</div>
                  <div className="gm-body">
                    <div className="gm-top">
                      <span className="gm-from">{r.sender}</span>
                      {r.hasAttachment && <Icon name="clip" size={13} className="gm-clip" />}
                      <span className="gm-date">{fmtMailDate(r.mailDate, emailDate)}</span>
                    </div>
                    <div className="gm-subj">{r.subject}</div>
                    {r.snippet && <div className="gm-snip">{r.snippet}</div>}
                    <div className="gm-tags">
                      {r.status === "processing" ? (
                        <span className="st-pill st-proc">⟳ parsing</span>
                      ) : r.status === "error" ? (
                        <span className="st-pill st-err">✕ error</span>
                      ) : r.status === "review" && r.flagged > 0 ? (
                        <span className="gm-review">⚠ {r.flagged} to review</span>
                      ) : (
                        <span className={`conf ${band}`} title={r.confidenceLabel || ""}><span className="cd" />{r.pct}%</span>
                      )}
                      <span className="vcount">{r.count} position{r.count !== 1 ? "s" : ""}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Right panel ── */}
      <div className={`rpanel ${view === "home" || view === "today" || view === "inbox" || view === "list" || view === "review" || view === "library" ? "rpanel-fill" : ""}`}>
        {/* Position List stays mounted so a generated draft survives tab switches */}
        <div style={{ display: view === "today" ? "contents" : "none" }}>
          <ValidationView isActive={view === "today"} refreshKey={vesselRefreshKey} />
        </div>
        {view === "today" ? null : loading && view !== "home" && view !== "inbox" && view !== "list" && view !== "review" && view !== "library" ? (
          <div className="center-load"><span className="spin-ring" /> Loading…</div>
        ) : view === "home" ? (
          <HomeView
            data={homeSummary}
            loading={homeLoading}
            error={homeError}
            onNavigate={go}
            onRefresh={loadHome}
          />
        ) : view === "inbox" ? (
          <InboxView
            onEmailsLoaded={syncHomeIfReviewCountChanged}
            onVesselsUpdated={() => { setVesselRefreshKey((k) => k + 1); setHomeRefreshKey((k) => k + 1); }}
            onContactsUpdated={() => setContactRefreshKey((k) => k + 1)}
          />
        ) : view === "review" ? (
          <InboxView
            reviewMode
            onEmailsLoaded={syncHomeIfReviewCountChanged}
            onVesselsUpdated={() => { setVesselRefreshKey((k) => k + 1); setHomeRefreshKey((k) => k + 1); }}
            onContactsUpdated={() => setContactRefreshKey((k) => k + 1)}
          />
        ) : view === "list" ? (
          <ContactListView isActive={view === "list"} refreshKey={contactRefreshKey} />
        ) : view === "library" ? (
          <VesselLibraryView
            isActive={view === "library"}
            refreshKey={libraryRefreshKey}
            onLibraryUpdated={() => setLibraryRefreshKey((k) => k + 1)}
          />
        ) : selectedAtt ? (
          <EmailDetail attachment={selectedAtt} emailId={activeEmailId} sender={selRow?.sender} subject={selRow?.subject}
            date={fmtMailDate(selRow?.mailDate, emailDate)} files={selRow?.files || []}
            positions={selectedPositions} onConfirm={onConfirm} onVerifiedChange={onVerifiedChange} />
        ) : (
          <div className="ed-empty"><div className="em">📭</div><div>Select an email on the left to see its parsed positions.</div></div>
        )}
      </div>
      </div>
      </div>

      {sendModal && (
        <div className="modal-bg" onClick={(e) => e.target.classList.contains("modal-bg") && setSendModal(false)}>
          <div className="modal">
            <h3>Send today’s position list?</h3>
            <p>This will email the consolidated list to your charterer groups. (Sending isn’t wired to a mail server yet — preview.)</p>
            <div className="recap">
              <div className="r"><span>Positions</span><b>{positions} · {zonesCount} zones</b></div>
              <div className="r"><span>Recipients</span><b>2 groups · 34 people</b></div>
            </div>
            <div className="mbtns">
              <button className="m-cancel" onClick={() => setSendModal(false)}>Cancel</button>
              <button className="m-send" onClick={() => { setSendModal(false); toast("📤 (Preview) Sent to charterer groups"); }}>📤 Send now</button>
            </div>
          </div>
        </div>
      )}

      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}
