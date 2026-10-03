import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (api.isPlayerLoggedIn()) navigate("/me");
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { token, username: name } = await api.login(username.trim(), password);
      api.setPlayerSession(token, name);
      navigate("/me");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="screen">
      <Link className="back-link" to="/">
        ← Back
      </Link>
      <div className="brand">
        <h1>Login</h1>
      </div>
      <p className="subtitle">Log in to see your stats, ranking, and history.</p>
      <form className="stack" onSubmit={submit}>
        <div>
          <label>Username</label>
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Your username" />
        </div>
        <div>
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className="btn primary" type="submit" disabled={loading || !username || !password}>
          {loading ? "Logging in…" : "Log in"}
        </button>
      </form>
      <p className="subtitle" style={{ marginTop: 24 }}>
        New player? Ask your host to show their registration QR code and scan it with your phone's camera to sign up.
      </p>
    </div>
  );
}
