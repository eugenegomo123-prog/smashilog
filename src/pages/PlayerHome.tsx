import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  playerKey,
  type Account,
  type ActiveSessionForAccount,
  type ActiveSessionInfo,
  type HistoryEntry,
  type OverallStats,
  type RankingEntry,
} from "../api";

type Tab = "home" | "ranking" | "history" | "account";

export default function PlayerHome() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("home");
  const [account, setAccount] = useState<Account | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveSessionInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!api.isPlayerLoggedIn()) {
      navigate("/login");
      return;
    }
    load();
  }, []);

  async function load() {
    try {
      const me = await api.getMe();
      setAccount(me.account);
      setActiveSession(me.activeSession);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load account");
    }
  }

  if (!account) return <div className="screen empty-state">{error || "Loading…"}</div>;

  return (
    <div className="screen">
      <div className="brand row between">
        <h1>Hi, {account.name}</h1>
      </div>
      {error && <div className="error-text">{error}</div>}

      {tab === "home" && <OverallStatsTab activeSession={activeSession} onChanged={load} />}
      {tab === "ranking" && <RankingTab />}
      {tab === "history" && <HistoryTab />}
      {tab === "account" && <AccountTab account={account} />}

      <nav className="tabs">
        <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}>
          Home
        </button>
        <button className={tab === "ranking" ? "active" : ""} onClick={() => setTab("ranking")}>
          Ranking
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          History
        </button>
        <button className={tab === "account" ? "active" : ""} onClick={() => setTab("account")}>
          Account
        </button>
      </nav>
    </div>
  );
}

function OverallStatsTab({
  activeSession,
  onChanged,
}: {
  activeSession: ActiveSessionInfo | null;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [stats, setStats] = useState<OverallStats | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [sessionsList, setSessionsList] = useState<ActiveSessionForAccount[] | null>(null);
  const [joining, setJoining] = useState<number | null>(null);

  useEffect(() => {
    api.getOverallStats().then(setStats);
  }, []);

  async function openSessionList() {
    setShowSessions(true);
    setSessionsList(await api.listActiveSessionsForAccount());
  }

  async function joinSession(sessionId: number) {
    setJoining(sessionId);
    try {
      const player = await api.joinSessionAsAccount(sessionId);
      localStorage.setItem(playerKey(sessionId), String(player.id));
      navigate(`/session/${sessionId}`);
    } finally {
      setJoining(null);
    }
  }

  function returnToSession(sessionId: number, playerId: number) {
    localStorage.setItem(playerKey(sessionId), String(playerId));
    navigate(`/session/${sessionId}`);
  }

  return (
    <div className="stack">
      {activeSession ? (
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 8 }}>You have an active session.</div>
          <div style={{ color: "var(--muted)", marginBottom: 12 }}>{activeSession.sessionName}</div>
          <button className="btn primary" onClick={() => returnToSession(activeSession.sessionId, activeSession.playerId)}>
            Return to Session
          </button>
        </div>
      ) : (
        <button className="btn primary" onClick={openSessionList}>
          Join a Session
        </button>
      )}

      {showSessions && !activeSession && (
        <div className="stack">
          {sessionsList === null && <div className="empty-state">Loading…</div>}
          {sessionsList?.map((s) => (
            <div key={s.id} className="card row between">
              <div>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>{s.playerCount} players</div>
              </div>
              {s.alreadyJoined ? (
                <span className="badge pending">{s.pendingApproval ? "Pending" : "Joined"}</span>
              ) : (
                <button className="btn small primary" disabled={joining === s.id} onClick={() => joinSession(s.id)}>
                  {joining === s.id ? "Joining…" : "Join"}
                </button>
              )}
            </div>
          ))}
          {sessionsList && sessionsList.length === 0 && <div className="empty-state">No active sessions right now.</div>}
        </div>
      )}

      <h3 style={{ fontSize: 15, color: "var(--muted)", marginTop: 8 }}>Overall stats</h3>
      {stats ? (
        <div className="card">
          <div className="row between" style={{ marginBottom: 10 }}>
            <StatBlock label="Sessions" value={stats.sessionsPlayed} />
            <StatBlock label="Games" value={stats.gamesPlayed} />
            <StatBlock label="W-L" value={`${stats.wins}-${stats.losses}`} />
          </div>
          <div className="row between">
            <StatBlock label="Total pts" value={stats.totalPoints} />
            <StatBlock label="Avg score" value={stats.averageScore} />
            <StatBlock label="Best score" value={stats.highestScore} />
          </div>
        </div>
      ) : (
        <div className="empty-state">Loading…</div>
      )}
    </div>
  );
}

function StatBlock({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ textAlign: "center", flex: 1 }}>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

function RankingTab() {
  const [period, setPeriod] = useState("all");
  const [months, setMonths] = useState<string[]>([]);
  const [ranking, setRanking] = useState<RankingEntry[] | null>(null);

  useEffect(() => {
    api.getRankingMonths().then(setMonths);
  }, []);

  useEffect(() => {
    setRanking(null);
    api.getRanking(period).then(setRanking);
  }, [period]);

  return (
    <div>
      <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ marginBottom: 16 }}>
        <option value="all">All Time</option>
        {months.map((m) => (
          <option key={m} value={m}>
            {monthLabel(m)}
          </option>
        ))}
      </select>
      <div className="table-wrap">
        <table className="ranking">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>W-L</th>
              <th>Games</th>
              <th>Points</th>
            </tr>
          </thead>
          <tbody>
            {ranking?.map((r, i) => (
              <tr key={r.accountId}>
                <td>{i + 1}</td>
                <td>{r.name}</td>
                <td>
                  {r.wins}-{r.losses}
                </td>
                <td>{r.gamesPlayed}</td>
                <td>{r.totalPoints}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ranking && ranking.length === 0 && <div className="empty-state">No ranked games yet for this period.</div>}
      {!ranking && <div className="empty-state">Loading…</div>}
    </div>
  );
}

function monthLabel(m: string): string {
  const [year, month] = m.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
}

function HistoryTab() {
  const navigate = useNavigate();
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    api.getHistory().then(setHistory);
  }, []);

  return (
    <div className="stack">
      {history?.map((h) => (
        <div
          key={h.sessionId}
          className="card"
          style={{ cursor: "pointer" }}
          onClick={() => {
            localStorage.setItem(playerKey(h.sessionId), String(h.playerId));
            navigate(`/session/${h.sessionId}`);
          }}
        >
          <div className="row between">
            <div style={{ fontWeight: 600 }}>{h.sessionName}</div>
            <span className={`badge ${h.sessionStatus === "active" ? "active" : "ended"}`}>{h.sessionStatus}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            {new Date(h.date).toLocaleDateString()} · {h.gamesPlayed} games · {h.wins}W-{h.losses}L · {h.totalPoints} pts
          </div>
        </div>
      ))}
      {history && history.length === 0 && <div className="empty-state">No sessions played yet.</div>}
      {!history && <div className="empty-state">Loading…</div>}
    </div>
  );
}

function AccountTab({ account }: { account: Account }) {
  const navigate = useNavigate();
  return (
    <div className="stack">
      <div className="card">
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Display name</div>
        <div style={{ fontWeight: 600 }}>{account.name}</div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 10 }}>Username</div>
        <div style={{ fontWeight: 600 }}>{account.username}</div>
      </div>
      <button
        className="btn danger"
        onClick={() => {
          api.clearPlayerToken();
          navigate("/");
        }}
      >
        Log Out
      </button>
    </div>
  );
}
