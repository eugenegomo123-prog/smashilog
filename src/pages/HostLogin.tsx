import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Icon } from "../ui/Icon";

export default function HostLogin() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (api.isHost()) navigate("/host/sessions");
  }, []);

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
      <Link className="back-link" to="/">
        <Icon name="chevron-left" size={16} />
        Back
      </Link>
      <div className="brand">
        <h1>Host Login</h1>
      </div>
      <p className="subtitle">Enter the host password to manage sessions.</p>
      <form className="stack card auth-card" onSubmit={submit}>
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
        <button className="btn primary block" type="submit" disabled={loading || !password}>
          {loading ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
