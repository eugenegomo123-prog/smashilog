import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

type Tab = "stats" | "ranking" | "history" | "account";

interface MeInfo {
  username: string;
  activeParticipation: { sessionId: number; sessionName: string; approved: boolean } | null;
}

interface OverallStats {
  sessionsPlayed: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  pointsFor: number;
  averageScore: number;
  highestScore: number;
}

interface JoinableSession {
  id: number;
  name: string;
  playerCount: number;
  alreadyJoined: boolean;
  approved: boolean;
}

export default function PlayerHome() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("stats");

  useEffect(() => {
    if (!api.isPlayerLoggedIn()) navigate("/login");
  }, []);

  if (!api.isPlayerLoggedIn()) return null;

  return (
    <div className="screen">
      <a className="back-link" href="/">
        ← Back
      </a>
      <div className="brand">
        <h1>Hi, {api.playerUsername()}</h1>
      </div>

      {tab === "stats" && <StatsTab />}
      {tab === "ranking" && <ComingSoon label="Overall ranking" />}
      {tab === "history" && <ComingSoon label="Session history" />}
      {tab === "account" && <AccountTab />}

      <nav className="tabs">
        <button className={tab === "stats" ? "active" : ""} onClick={() => setTab("stats")}>📊 Stats</button>
        <button className={tab === "ranking" ? "active" : ""} onClick={() => setTab("ranking")}>🏆 Ranking</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>📜 History</button>
        <button className={tab === "account" ? "active" : ""} onClick={() => setTab("account")}>⚙️ Account</button>
      </nav>
    </div>
  );
}

function ComingSoon({ label }: { label: string }) {
  return <div className="empty-state">{label} is coming soon.</div>;
}

function StatsTab() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeInfo | null>(null);
  const [stats, setStats] = useState<OverallStats | null>(null);
  const [sessionsList, setSessionsList] = useState<JoinableSession[] | null>(null);

  useEffect(() => {
    api.getMe().then(setMe);
    api.getOverallStats().then(setStats);
    api.getJoinableSessions().then(setSessionsList);
  }, []);

  const winPct = stats && stats.gamesPlayed ? Math.round((stats.wins / stats.gamesPlayed) * 100) : 0;

  return (
    <div className="stack">
      {me?.activeParticipation && (
        <div className="card">
          <div style={{ fontSize: 13, color: "var(--muted)" }}>You're in a session right now</div>
          <div style={{ fontWeight: 700, fontSize: 18, marginTop: 2 }}>{me.activeParticipation.sessionName}</div>
          {me.activeParticipation.approved ? (
            <button
              className="btn primary"
              style={{ marginTop: 10 }}
              onClick={() => navigate(`/session/${me.activeParticipation!.sessionId}`)}
            >
              Return to session
            </button>
          ) : (
            <div className="subtitle" style={{ marginTop: 6, marginBottom: 0 }}>
              Waiting for the host to approve your join request.
            </div>
          )}
        </div>
      )}

      {stats && (
        <div className="card">
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>Overall record</div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span>Sessions played</span>
            <strong>{stats.sessionsPlayed}</strong>
          </div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span>Games played</span>
            <strong>{stats.gamesPlayed}</strong>
          </div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span>Wins - Losses</span>
            <strong>{stats.wins}-{stats.losses} ({winPct}%)</strong>
          </div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span>Average score</span>
            <strong>{stats.averageScore.toFixed(1)}</strong>
          </div>
          <div className="row between">
            <span>Highest score</span>
            <strong>{stats.highestScore}</strong>
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 15, color: "var(--muted)" }}>Join a session</h3>
      <div className="stack">
        {sessionsList?.map((s) => (
          <div key={s.id} className="card row between">
            <div>
              <div style={{ fontWeight: 600 }}>{s.name}</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{s.playerCount} players</div>
            </div>
            {s.alreadyJoined ? (
              <span className={`badge ${s.approved ? "active" : "pending"}`}>
                {s.approved ? "joined" : "pending"}
              </span>
            ) : (
              <button className="btn small primary" onClick={() => navigate(`/join/${s.id}`)}>
                Request to join
              </button>
            )}
          </div>
        ))}
        {sessionsList?.length === 0 && <div className="empty-state">No active sessions right now.</div>}
      </div>
    </div>
  );
}

function AccountTab() {
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    if (newPassword !== confirm) {
      setError("New passwords don't match");
      return;
    }
    setSubmitting(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setSuccess("Password updated.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Username</div>
        <div style={{ fontWeight: 700, fontSize: 18 }}>{api.playerUsername()}</div>
      </div>

      <div className="card">
        <label>Change password</label>
        <form className="stack" onSubmit={submit}>
          <input
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {error && <div className="error-text">{error}</div>}
          {success && <div style={{ color: "var(--good)", fontSize: 14 }}>{success}</div>}
          <button className="btn primary" type="submit" disabled={submitting || !currentPassword || !newPassword}>
            {submitting ? "Updating…" : "Update password"}
          </button>
        </form>
      </div>

      <button
        className="btn danger"
        onClick={() => {
          api.clearPlayerSession();
          navigate("/");
        }}
      >
        Log out
      </button>
    </div>
  );
}
