import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Session } from "../api";
import { Icon } from "../ui/Icon";
import { SessionRow } from "../ui/SessionRow";

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
      <Link className="back-link" to="/">
        <Icon name="chevron-left" size={16} />
        Back
      </Link>
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
            <div className="stepper">
              <button
                type="button"
                className="icon-btn lg"
                aria-label="Fewer courts"
                disabled={courtCount <= 1}
                onClick={() => setCourtCount(Math.max(1, courtCount - 1))}
              >
                <Icon name="minus" size={20} />
              </button>
              <input
                type="number"
                min={1}
                max={20}
                inputMode="numeric"
                value={courtCount}
                onChange={(e) => setCourtCount(Number(e.target.value))}
              />
              <button
                type="button"
                className="icon-btn lg"
                aria-label="More courts"
                disabled={courtCount >= 20}
                onClick={() => setCourtCount(Math.min(20, courtCount + 1))}
              >
                <Icon name="plus" size={20} />
              </button>
            </div>
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn primary block" type="submit" disabled={creating || !name.trim()}>
            {creating ? "Creating…" : "Create session"}
          </button>
        </form>
      </div>

      <h3 className="section-title" style={{ marginTop: 28, marginBottom: 8 }}>Active</h3>
      <div className="stack">
        {active.map((s) => (
          <SessionRow
            key={s.id}
            title={s.name}
            sub={`${s.courtCount} courts`}
            status={s.status === "active" ? "active" : "ended"}
            onClick={() => navigate(`/host/sessions/${s.id}`)}
          />
        ))}
        {sessions && active.length === 0 && <div className="empty-state">No active sessions yet.</div>}
      </div>

      {ended.length > 0 && (
        <>
          <h3 className="section-title" style={{ marginTop: 28, marginBottom: 8 }}>Ended</h3>
          <div className="stack">
            {ended.map((s) => (
              <SessionRow
                key={s.id}
                title={s.name}
                sub={`${s.courtCount} courts`}
                status="ended"
                onClick={() => navigate(`/host/sessions/${s.id}`)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
