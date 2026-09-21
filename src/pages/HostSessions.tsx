import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Session } from "../api";

export default function HostSessions() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [name, setName] = useState("");
  const [courtCount, setCourtCount] = useState(4);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!api.isHost()) {
      navigate("/host");
      return;
    }
    load();
  }, []);

  async function load() {
    setSessions(await api.listSessions());
  }

  async function createSession(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setCreating(true);
    try {
      const session = await api.createSession(name.trim(), courtCount);
      navigate(`/host/sessions/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
    } finally {
      setCreating(false);
    }
  }

  const active = sessions?.filter((s) => s.status === "active") ?? [];
  const ended = sessions?.filter((s) => s.status === "ended") ?? [];

  return (
    <div className="screen">
      <a className="back-link" href="/">
        ← Back
      </a>
      <div className="brand">
        <h1>Host Sessions</h1>
      </div>
      <p className="subtitle">Create a new session or manage an existing one.</p>

      <div className="card">
        <form className="stack" onSubmit={createSession}>
          <div>
            <label>Session name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Saturday Smash" />
          </div>
          <div>
            <label>Number of courts</label>
            <input
              type="number"
              min={1}
              max={20}
              value={courtCount}
              onChange={(e) => setCourtCount(Number(e.target.value))}
            />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn primary" type="submit" disabled={creating || !name.trim()}>
            {creating ? "Creating…" : "Create session"}
          </button>
        </form>
      </div>

      <h3 style={{ marginTop: 28, marginBottom: 8, fontSize: 15, color: "var(--muted)" }}>Active</h3>
      <div className="stack">
        {active.map((s) => (
          <SessionRow key={s.id} session={s} onClick={() => navigate(`/host/sessions/${s.id}`)} />
        ))}
        {sessions && active.length === 0 && <div className="empty-state">No active sessions yet.</div>}
      </div>

      {ended.length > 0 && (
        <>
          <h3 style={{ marginTop: 28, marginBottom: 8, fontSize: 15, color: "var(--muted)" }}>Ended</h3>
          <div className="stack">
            {ended.map((s) => (
              <SessionRow key={s.id} session={s} onClick={() => navigate(`/host/sessions/${s.id}`)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SessionRow({ session, onClick }: { session: Session; onClick: () => void }) {
  return (
    <div className="card row between" onClick={onClick} style={{ cursor: "pointer" }}>
      <div>
        <div style={{ fontWeight: 600 }}>{session.name}</div>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>{session.courtCount} courts</div>
      </div>
      <span className={`badge ${session.status === "active" ? "active" : "ended"}`}>{session.status}</span>
    </div>
  );
}
