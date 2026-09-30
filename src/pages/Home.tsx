import { useNavigate } from "react-router-dom";

export default function Home() {
  const navigate = useNavigate();
  return (
    <div className="screen">
      <div className="brand">
        <h1>
          Smashilog<span className="dot">.</span>
        </h1>
      </div>
      <p className="subtitle">Tara, Smash!</p>
      <div className="stack" style={{ marginTop: 40 }}>
        <button className="big-btn primary" onClick={() => navigate("/login")}>
          Login
        </button>
        <button className="big-btn ghost" onClick={() => navigate("/join")}>
          🏸 Join as Guest
        </button>
      </div>
      <a className="host-corner-link" href="/host">
        Host →
      </a>
    </div>
  );
}
