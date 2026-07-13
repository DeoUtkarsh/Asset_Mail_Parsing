import { useState } from "react";

export default function Settings({ filterSender, onGo, toast }) {
  const [thresh, setThresh] = useState(90);
  const [interval, setInterval] = useState("Manual only");

  return (
    <div className="wrap">
      <button className="backlink" onClick={() => onGo("today")}>← Back to Today</button>
      <div className="pagehead">
        <h1>Settings</h1>
        <p>Whose emails to read, who to send to, and how sure the system must be before auto-confirming.</p>
      </div>

      <div className="set-card">
        <h3>Owner senders <span className="disabled-note">from .env</span></h3>
        <div className="sd">Only emails from these are fetched and parsed as owner positions. (Edit in backend config for now.)</div>
        <div className="taglist">
          <span className="tag2">{filterSender || "sanjib@iconshipbrokers.com"}</span>
          <button className="addbtn" onClick={() => toast("Editable sender list — coming soon")}>＋ Add sender</button>
        </div>
      </div>

      <div className="set-card">
        <h3>Charterer recipients <span className="disabled-note">soon</span></h3>
        <div className="sd">Groups the position list is sent to. Not wired to sending yet.</div>
        <div className="rgroup"><span className="av">DC</span><div><div className="rn">Dry Cargo desk</div><div className="rd">22 recipients · all zones</div></div><button className="rowbtn" style={{ marginLeft: "auto" }} onClick={() => toast("Recipient editing — coming soon")}>Edit</button></div>
        <div className="rgroup"><span className="av">AG</span><div><div className="rn">AG charterers</div><div className="rd">12 recipients · AG/Middle East</div></div><button className="rowbtn" style={{ marginLeft: "auto" }} onClick={() => toast("Recipient editing — coming soon")}>Edit</button></div>
        <button className="addbtn" style={{ marginTop: 12 }} onClick={() => toast("Add recipient group — coming soon")}>＋ Add group</button>
      </div>

      <div className="set-card">
        <h3>Auto-confirm threshold <span className="disabled-note">preview</span></h3>
        <div className="sd">Positions at least this confident get auto-confirmed; anything below goes to Review. (Confidence scoring lands with the next backend step.)</div>
        <div className="slider-row">
          <input type="range" min={70} max={99} value={thresh} onChange={(e) => setThresh(+e.target.value)} />
          <span className="thresh-val">{thresh}%</span>
        </div>
      </div>

      <div className="set-card">
        <h3>Auto-sync interval <span className="disabled-note">soon</span></h3>
        <div className="sd">How often the inbox is checked for new owner emails. Today, use “Sync now”.</div>
        <div className="seg">
          {["Every 5 min", "Every 15 min", "Hourly", "Manual only"].map((o) => (
            <button key={o} className={interval === o ? "on" : ""} onClick={() => { setInterval(o); toast("Interval preview only"); }}>{o}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
