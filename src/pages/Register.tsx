import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";

export default function Register() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (api.isPlayerLoggedIn()) navigate("/me");
  }, []);

  if (!token) {
    return (
      <div className="screen">
        <Link className="back-link" to="/">
          ← Back
        </Link>
        <div className="brand">
          <h1>Create account</h1>
        </div>
        <p className="subtitle">
          This page needs a registration link from your host's QR code — ask them to show it and scan it with your
          phone's camera.
        </p>
        <p className="subtitle">
          Already have an account? <Link to="/login">Log in</Link> instead.
        </p>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setLoading(true);
    try {
      const { token: playerToken, username: name } = await api.register(username.trim(), password, token);
      api.setPlayerSession(playerToken, name);
      navigate("/me");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create your account");
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
        <h1>Create account</h1>
      </div>
      <p className="subtitle">Pick a username and password — separate from any guest name you've used before.</p>
      <form className="stack" onSubmit={submit}>
        <div>
          <label>Username</label>
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="3-30 characters" />
        </div>
        <div>
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
        </div>
        <div>
          <label>Confirm password</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className="btn primary" type="submit" disabled={loading || !username || !password}>
          {loading ? "Creating…" : "Create account"}
        </button>
      </form>
      <p className="subtitle" style={{ marginTop: 24 }}>
        Already have an account? <Link to="/login">Log in</Link> instead.
      </p>
    </div>
  );
}
