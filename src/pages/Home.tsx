import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

export default function Home() {
  const navigate = useNavigate();
  const loggedIn = api.isPlayerLoggedIn();

  return (
    <div className="screen">
      <div className="brand">
        <h1>
          Smashilog<span className="dot">.</span>
        </h1>
      </div>
      <p className="subtitle">Tara, Smash!</p>
      <div className="stack" style={{ marginTop: 40 }}>
        {loggedIn ? (
          <button className="big-btn primary" onClick={() => navigate("/me")}>
            👋 Continue as {api.playerUsername()}
          </button>
        ) : (
          <button className="big-btn primary" onClick={() => navigate("/login")}>
            Login
          </button>
        )}
        <button className="big-btn ghost" onClick={() => navigate("/join")}>
          🏸 Join as Guest
        </button>
      </div>
      <Link className="host-corner-link" to="/host">
        Host →
      </Link>
    </div>
  );
}
