import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

type Mode = "choose" | "login" | "signup-info";

export default function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("choose");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { token } = await api.login(username.trim(), password);
      api.setPlayerToken(token);
      navigate("/player");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="screen">
      <a className="back-link" href="/">
        ← Back
      </a>
      <div className="brand">
        <h1>Player Login</h1>
      </div>

      {mode === "choose" && (
        <div className="stack" style={{ marginTop: 24 }}>
          <button className="big-btn primary" onClick={() => setMode("login")}>
            Log In
          </button>
          <button className="big-btn ghost" onClick={() => setMode("signup-info")}>
            Sign Up
          </button>
        </div>
      )}

      {mode === "login" && (
        <form className="stack" onSubmit={submitLogin} style={{ marginTop: 24 }}>
          <div>
            <label>Username</label>
            <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Your username" />
          </div>
          <div>
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn primary" type="submit" disabled={loading || !username || !password}>
            {loading ? "Logging in…" : "Log In"}
          </button>
          <button type="button" className="btn" onClick={() => setMode("choose")}>
            Back
          </button>
        </form>
      )}

      {mode === "signup-info" && (
        <div className="stack" style={{ marginTop: 24 }}>
          <div className="card">
            To create a player account, please scan the QR code provided by the host. Contact the host if you need the
            registration QR code.
          </div>
          <button className="btn" onClick={() => setMode("choose")}>
            Back
          </button>
        </div>
      )}
    </div>
  );
}
