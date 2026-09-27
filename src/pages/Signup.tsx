import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";

export default function Signup() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // The registration flow is only reachable through the host's QR code, which encodes
  // this exact URL with a `token` query param. No token means someone landed here some
  // other way (typed the URL, followed an old link, etc.) -- show the same instructional
  // message the Login page's "Sign Up" button shows, rather than a form.
  if (!token) {
    return (
      <div className="screen">
        <a className="back-link" href="/">
          ← Back
        </a>
        <div className="brand">
          <h1>Create Account</h1>
        </div>
        <div className="card">
          To create a player account, please scan the QR code provided by the host. Contact the host if you need the
          registration QR code.
        </div>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { token: playerToken } = await api.signup(token, username.trim(), password, name.trim());
      api.setPlayerToken(playerToken);
      navigate("/player");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="screen">
      <div className="brand">
        <h1>Create Account</h1>
      </div>
      <p className="subtitle">You're signing up via the host's registration QR code.</p>
      <form className="stack" onSubmit={submit}>
        <div>
          <label>Display name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
        </div>
        <div>
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Choose a username" />
        </div>
        <div>
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 6 characters"
          />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className="btn primary" type="submit" disabled={loading || !username.trim() || !password || !name.trim()}>
          {loading ? "Creating account…" : "Create Account"}
        </button>
      </form>
    </div>
  );
}
