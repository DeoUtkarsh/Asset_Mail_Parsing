import { useState } from "react";
import Icon from "../icons";

const DEMO_USER = "demo123";
const DEMO_PASS = "123";

export default function LoginView({ onLogin }) {
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = (e) => {
    e.preventDefault();
    if (userId.trim() === DEMO_USER && password === DEMO_PASS) {
      setError("");
      onLogin();
    } else {
      setError("Invalid user ID or password.");
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-bg" aria-hidden="true" />
      <div className="login-tint" aria-hidden="true" />
      <div className="login-mist" aria-hidden="true" />

      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="login-mark"><Icon name="anchor" size={26} /></span>
          <div className="login-wm">
            <span className="l1">BROKER</span> <span className="l2">SENSE</span>
          </div>
        </div>

        <h1 className="login-title">Welcome back</h1>
        <p className="login-sub">Sign in to your position desk</p>

        <label className="login-field">
          <span>User ID</span>
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="demo123"
            autoFocus
            autoComplete="username"
          />
        </label>

        <label className="login-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••"
            autoComplete="current-password"
          />
        </label>

        {error && <div className="login-err">{error}</div>}

        <button type="submit" className="login-btn">Sign in</button>

        <div className="login-hint">Demo access — <b>demo123</b> / <b>123</b></div>
      </form>
    </div>
  );
}
