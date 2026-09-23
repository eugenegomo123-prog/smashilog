import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, LEVELS, LEVEL_ICON, LEVEL_LABEL, type Level, type Match, type Player, type Session } from "../api";
import { playerKey } from "./ParticipantJoin";

type Tab = "dashboard" | "ongoing" | "ranking" | "history";

export default function ParticipantSession() {
  const { id } = useParams();
  const sessionId = Number(id);
  const [session, setSession] = useState<Session | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [matchData, setMatchData] = useState<{ ongoing: Match[]; history: Match[]; suggested: Match[] }>({
    ongoing: [],
    history: [],
    suggested: [],
  });
  const [toast, setToast] = useState<string | null>(null);
  const wasOnCourt = useRef(false);

  const myId = Number(localStorage.getItem(playerKey(sessionId))) || null;
  const isEnded = session?.status === "ended";
  const [tab, setTab] = useState<Tab>(isEnded ? "ranking" : "dashboard");

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [sessionId]);

  useEffect(() => {
    if (isEnded && (tab === "dashboard" || tab === "ongoing")) setTab("ranking");
  }, [isEnded]);

  async function load() {
    const [s, p, m] = await Promise.all([
      api.getSession(sessionId),
      api.listPlayers(sessionId),
      api.getMatches(sessionId),
    ]);
    setSession(s);
    setPlayers(p);
    setMatchData(m);
    checkOnCourt(m.ongoing);
  }

  // Since matches now come from a pool of suggestions the host chooses between
  // (rather than one fixed, ordered queue), there's no reliable "you're up
  // soon" position to predict anymore. Instead, this fires the moment the host
  // actually sends you out to a court -- accurate, if a little less advance notice.
  function checkOnCourt(ongoing: Match[]) {
    if (!myId) return;
    const myMatch = ongoing.find((m) => [...m.team1, ...m.team2].includes(myId));
    const isOnCourtNow = !!myMatch;
    if (isOnCourtNow && !wasOnCourt.current) {
      fireNotification(`You're on ${myMatch!.courtLabel} — head to the court!`);
    }
    wasOnCourt.current = isOnCourtNow;
  }

  function fireNotification(message: string) {
    setToast(message);
    if (navigator.vibrate) navigator.vibrate([100, 60, 100]);
    setTimeout(() => setToast(null), 5000);
  }

  const playerById = (pid: number) => players.find((p) => p.id === pid);
  const me = myId ? players.find((p) => p.id === myId) : undefined;

  if (!session) return <div className="screen empty-state">Loading…</div>;

  return (
    <div className="screen">
      <a className="back-link" href="/join">
        ← All sessions
      </a>
      {toast && <div className="toast">{toast}</div>}
      <div className="brand row between">
        <h1>{session.name}</h1>
        <span className={`badge ${session.status === "active" ? "active" : "ended"}`}>{session.status}</span>
      </div>

      {tab === "dashboard" && me && <DashboardTab player={me} onChanged={load} />}
      {tab === "ongoing" && <OngoingTab matches={matchData.ongoing} playerById={playerById} myId={myId} />}
      {tab === "ranking" && <RankingTab players={players.filter((p) => p.approved)} />}
      {tab === "history" && <HistoryTab history={matchData.history} playerById={playerById} />}

      <nav className="tabs">
        {!isEnded && <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>🏠 Dashboard</button>}
        {!isEnded && <button className={tab === "ongoing" ? "active" : ""} onClick={() => setTab("ongoing")}>🏸 Courts</button>}
        <button className={tab === "ranking" ? "active" : ""} onClick={() => setTab("ranking")}>🏆 Ranking</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>📜 History</button>
      </nav>
    </div>
  );
}

function DashboardTab({ player, onChanged }: { player: Player; onChanged: () => void }) {
  const winPct = player.gamesPlayed ? Math.round((player.wins / player.gamesPlayed) * 100) : 0;
  return (
    <div className="stack">
      <div className="card">
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Signed in as</div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{player.name}</div>
      </div>
      <div className="card row between">
        <div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{winPct}%</div>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Win rate · {player.wins}W-{player.losses}L</div>
        </div>
        <div className="level-pill" style={{ width: 44, height: 44, fontSize: 22 }} title={LEVEL_LABEL[player.level]}>{LEVEL_ICON[player.level]}</div>
      </div>
      <div className="card">
        <label>My level</label>
        <select
          value={player.level}
          onChange={async (e) => {
            await api.updatePlayer(player.id, { level: e.target.value as Level });
            onChanged();
          }}
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {LEVEL_ICON[l]} {l} · {LEVEL_LABEL[l]}
            </option>
          ))}
        </select>
      </div>
      <div className="card">
        <label>My status</label>
        <select
          value={player.status}
          onChange={async (e) => {
            await api.updatePlayer(player.id, { status: e.target.value as Player["status"] });
            onChanged();
          }}
        >
          <option value="active">Active — put me in the rotation</option>
          <option value="resting">Resting</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>
    </div>
  );
}

function OngoingTab({
  matches,
  playerById,
  myId,
}: {
  matches: Match[];
  playerById: (id: number) => Player | undefined;
  myId: number | null;
}) {
  return (
    <div className="stack">
      {matches.map((m) => {
        const mine = [...m.team1, ...m.team2].includes(myId ?? -1);
        return (
          <div key={m.id} className="match-card" style={mine ? { borderColor: "var(--accent)" } : undefined}>
            <div className="court-label">{m.courtLabel}</div>
            <div className="team-row">
              <span>{m.team1.map((id) => playerById(id)?.name ?? "?").join(" & ")}</span>
            </div>
            <div className="team-row">
              <span>{m.team2.map((id) => playerById(id)?.name ?? "?").join(" & ")}</span>
            </div>
          </div>
        );
      })}
      {matches.length === 0 && <div className="empty-state">No games in progress.</div>}
    </div>
  );
}

function RankingTab({ players }: { players: Player[] }) {
  const sorted = [...players].sort((a, b) => {
    const wpA = a.gamesPlayed ? a.wins / a.gamesPlayed : 0;
    const wpB = b.gamesPlayed ? b.wins / b.gamesPlayed : 0;
    return wpB - wpA;
  });
  return (
    <div className="table-wrap">
      <table className="ranking">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>W-L</th>
            <th>Win%</th>
            <th>Streak</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p, i) => (
            <tr key={p.id}>
              <td>{i + 1}</td>
              <td>{p.name} <span style={{ color: "var(--muted)" }}>{LEVEL_ICON[p.level]} {p.level}</span></td>
              <td>{p.wins}-{p.losses}</td>
              <td>{p.gamesPlayed ? Math.round((p.wins / p.gamesPlayed) * 100) : 0}%</td>
              <td>{p.currentStreak > 0 ? `W${p.currentStreak}` : p.currentStreak < 0 ? `L${-p.currentStreak}` : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTab({ history, playerById }: { history: Match[]; playerById: (id: number) => Player | undefined }) {
  return (
    <div className="stack">
      {history.map((m) => (
        <div key={m.id} className="match-card">
          <div className="court-label">{m.courtLabel} · {new Date(m.endedAt ?? m.startedAt).toLocaleString()}</div>
          <div className="team-row">
            <span>{m.team1.map((id) => playerById(id)?.name ?? "?").join(" & ")}</span>
            <strong>{m.score1}</strong>
          </div>
          <div className="team-row">
            <span>{m.team2.map((id) => playerById(id)?.name ?? "?").join(" & ")}</span>
            <strong>{m.score2}</strong>
          </div>
        </div>
      ))}
      {history.length === 0 && <div className="empty-state">No completed matches yet.</div>}
    </div>
  );
}
