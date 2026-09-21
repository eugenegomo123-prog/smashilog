import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

export default function HostLogin() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { token } = await api.hostLogin(password);
      api.setHostToken(token);
      navigate("/host/sessions");
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
        <h1>Host Login</h1>
      </div>
      <p className="subtitle">Enter the host password to manage sessions.</p>
      <form className="stack" onSubmit={submit}>
        <div>
          <label>Password</label>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Host password"
          />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className="btn primary" type="submit" disabled={loading || !password}>
          {loading ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
