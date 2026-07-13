export default function Today({ stats, hasData, onGo, onSync, syncing }) {
  const { emails, positions, zones, need, readiness } = stats;

  if (!hasData) {
    return (
      <div className="wrap">
        <div className="empty">
          <div className="em">📭</div>
          <h2>No owner emails yet today</h2>
          <p>As soon as vessel owners send their open positions, they’ll be fetched and parsed here automatically. You can also pull them now.</p>
          <div>
            <button className="fetch-btn" onClick={onSync} disabled={syncing}>
              {syncing ? "Fetching…" : "⬇ Fetch owner emails now"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const ringColor = readiness >= 90 ? "var(--hi)" : readiness >= 70 ? "var(--mid)" : "var(--lo)";
  const ready = need === 0;

  return (
    <div className="wrap">
      <div className="hero">
        <div className="hero-top">
          <div className="ring" style={{ background: `conic-gradient(${ringColor} ${readiness}%, #e9f0f5 0)` }}>
            <div className="inner"><div><div className="pct">{readiness}%</div><div className="lbl">ready</div></div></div>
          </div>
          <div className="hero-txt">
            <h1>{ready ? "Ready to send" : "Almost ready to send"}</h1>
            <p>
              The system fetched <b>{emails} owner email{emails !== 1 ? "s" : ""}</b>, parsed{" "}
              <b>{positions} position{positions !== 1 ? "s" : ""}</b>, and compiled <b>{zones} zone{zones !== 1 ? "s" : ""}</b> — automatically.{" "}
              {ready ? "Nothing needs your attention." : <>Just <b>{need} position{need !== 1 ? "s" : ""}</b> need a quick check.</>}
            </p>
          </div>
        </div>
        <div className="pipe">
          <Step done label="Received" sub={`${emails} emails`} ic="✓" />
          <Step done label="Parsed" sub={`${positions} positions`} ic="✓" />
          <Step done label="Compiled" sub={`${zones} zones`} ic="✓" />
          <Step state={ready ? "done" : "todo"} label="Review" sub={ready ? "all clear" : `${need} to check`} ic={ready ? "✓" : String(need)} />
          <Step state="wait" label="Send" sub="to charterers" ic="↗" />
        </div>
      </div>

      <div className="cards">
        <button className={`acard ${need > 0 ? "attn" : ""}`} onClick={() => onGo("review")}>
          <div className="big" style={{ color: need > 0 ? "var(--mid)" : "var(--hi)" }}>{need}</div>
          <div className="t">Need your review</div>
          <div className="d">Positions with no clear open region — a quick confirm each.</div>
          <div className="go">{need > 0 ? "Review now →" : "All confirmed ✓"}</div>
        </button>
        <button className="acard" onClick={() => onGo("list")}>
          <div className="big" style={{ color: "var(--brand)" }}>{positions}</div>
          <div className="t">Positions ready</div>
          <div className="d">Compiled into {zones} zones, ready for charterers.</div>
          <div className="go">Open position list →</div>
        </button>
      </div>
    </div>
  );
}

function Step({ state, done, label, sub, ic }) {
  const cls = done ? "done" : state || "wait";
  return (
    <div className={`step ${cls}`}>
      <div className="ic">{ic}</div>
      <div className="st">{label}</div>
      <div className="ss">{sub}</div>
    </div>
  );
}
