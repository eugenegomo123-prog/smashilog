import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Session } from "../api";

export default function ParticipantSessions() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[] | null>(null);

  useEffect(() => {
    api.listSessions().then(setSessions);
  }, []);

  const active = sessions?.filter((s) => s.status === "active") ?? [];
  const ended = sessions?.filter((s) => s.status === "ended") ?? [];

  return (
    <div className="screen">
      <a className="back-link" href="/">
        ← Back
      </a>
      <div className="brand">
        <h1>Join a Session</h1>
      </div>
      <p className="subtitle">Pick an active session to check in, or view results from a past one.</p>

      <h3 style={{ fontSize: 15, color: "var(--muted)" }}>Active</h3>
      <div className="stack">
        {active.map((s) => (
          <div key={s.id} className="card row between" style={{ cursor: "pointer" }} onClick={() => navigate(`/join/${s.id}`)}>
            <div style={{ fontWeight: 600 }}>{s.name}</div>
            <span className="badge active">active</span>
          </div>
        ))}
        {sessions && active.length === 0 && <div className="empty-state">No active sessions right now.</div>}
      </div>

      {ended.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, color: "var(--muted)", marginTop: 24 }}>Past</h3>
          <div className="stack">
            {ended.map((s) => (
              <div key={s.id} className="card row between" style={{ cursor: "pointer" }} onClick={() => navigate(`/session/${s.id}`)}>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <span className="badge ended">ended</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
