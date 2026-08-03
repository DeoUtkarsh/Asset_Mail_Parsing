import { useState } from "react";
import { login } from "../../services/api";

export default function LoginView({ onLogin }) {
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await login(userId.trim(), password);
      onLogin({ userId: res.user_id, password, isDemo: !!res.is_demo });
    } catch (err) {
      setError(err?.message || "Invalid user ID or password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-bg" aria-hidden="true" />
      <div className="login-tint" aria-hidden="true" />
      <div className="login-mist" aria-hidden="true" />

      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <img className="login-mark" src="/logo-mark.png?v=3" alt="" aria-hidden="true" />
          <img className="login-brand-logo" src="/logo.png?v=6" alt="Broker Sense" />
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
            disabled={busy}
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
            disabled={busy}
          />
        </label>

        {error && <div className="login-err">{error}</div>}

        <button type="submit" className="login-btn" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <div className="login-hint">Demo access — <b>demo123</b> / <b>123</b></div>
      </form>
    </div>
  );
}
