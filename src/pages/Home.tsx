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
      <p className="subtitle">Badminton doubles session manager</p>
      <div className="stack" style={{ marginTop: 40 }}>
        <button className="big-btn primary" onClick={() => navigate("/host")}>
          🏸 Host a Session
        </button>
        <button className="big-btn ghost" onClick={() => navigate("/join")}>
          Join as Participant
        </button>
      </div>
    </div>
  );
}
