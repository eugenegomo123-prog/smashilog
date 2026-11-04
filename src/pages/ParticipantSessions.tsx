import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Session } from "../api";
import { Icon } from "../ui/Icon";
import { SessionRow } from "../ui/SessionRow";
import { ListSkeleton } from "../ui/Skeleton";

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
      <Link className="back-link" to="/">
        <Icon name="chevron-left" size={16} />
        Back
      </Link>
      <div className="brand">
        <h1>Join a Session</h1>
      </div>
      <p className="subtitle">Pick an active session to check in, or view results from a past one.</p>

      <h3 className="section-title">Active</h3>
      <div className="stack">
        {active.map((s) => (
          <SessionRow key={s.id} title={s.name} status="active" onClick={() => navigate(`/join/${s.id}`)} />
        ))}
        {sessions === null && <ListSkeleton rows={2} />}
        {sessions && active.length === 0 && <div className="empty-state">No active sessions right now.</div>}
      </div>

      {ended.length > 0 && (
        <>
          <h3 className="section-title" style={{ marginTop: 24 }}>Past</h3>
          <div className="stack">
            {ended.map((s) => (
              <SessionRow key={s.id} title={s.name} status="ended" onClick={() => navigate(`/session/${s.id}`)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
