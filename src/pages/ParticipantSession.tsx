import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, LEVELS, LEVEL_ICON, LEVEL_LABEL, type Level, type Match, type Player, type Session } from "../api";
import { playerKey } from "./ParticipantJoin";

type Tab = "dashboard" | "ongoing" | "queue" | "ranking" | "history";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function rankCompare(a: Player, b: Player) {
  if (b.wins !== a.wins) return b.wins - a.wins;
  const wpA = a.gamesPlayed ? a.wins / a.gamesPlayed : 0;
  const wpB = b.gamesPlayed ? b.wins / b.gamesPlayed : 0;
  if (wpB !== wpA) return wpB - wpA;
  if (a.losses !== b.losses) return a.losses - b.losses;
  return a.name.localeCompare(b.name);
}

// Longest win streak any player actually reached during the session (not just
// their final/current one), scanned from the completed-match history.
function computeLongestStreaks(history: Match[]): Map<number, number> {
  const sorted = [...history].sort(
    (a, b) => new Date(a.endedAt ?? a.startedAt).getTime() - new Date(b.endedAt ?? b.startedAt).getTime(),
  );
  const running = new Map<number, number>();
  const longest = new Map<number, number>();
  for (const m of sorted) {
    const team1Won = (m.score1 ?? 0) > (m.score2 ?? 0);
    for (const pid of m.team1) {
      const next = team1Won ? (running.get(pid) ?? 0) + 1 : 0;
      running.set(pid, next);
      longest.set(pid, Math.max(longest.get(pid) ?? 0, next));
    }
    for (const pid of m.team2) {
      const next = !team1Won ? (running.get(pid) ?? 0) + 1 : 0;
      running.set(pid, next);
      longest.set(pid, Math.max(longest.get(pid) ?? 0, next));
    }
  }
  return longest;
}

function buildAwards(players: Player[], history: Match[]) {
  const withGames = players.filter((p) => p.gamesPlayed > 0);
  if (withGames.length === 0) return null;
  const mostGames = [...withGames].sort((a, b) => b.gamesPlayed - a.gamesPlayed)[0];
  const bestDiff = [...withGames].sort(
    (a, b) => (b.pointsFor - b.pointsAgainst) / b.gamesPlayed - (a.pointsFor - a.pointsAgainst) / a.gamesPlayed,
  )[0];
  const longestStreaks = computeLongestStreaks(history);
  let streakPlayer: Player | null = null;
  let streakValue = 0;
  for (const p of withGames) {
    const s = longestStreaks.get(p.id) ?? 0;
    if (s > streakValue) {
      streakValue = s;
      streakPlayer = p;
    }
  }
  return { mostGames, bestDiff, streakPlayer, streakValue };
}

function buildResultsText(session: Session, players: Player[]): string {
  const sorted = [...players].sort(rankCompare);
  const lines = sorted.map((p, i) => `${i + 1}. ${p.name} — ${p.wins}-${p.losses}`);
  return `🏸 ${session.name} — Standings\n\n${lines.join("\n")}`;
}

async function shareResults(session: Session, players: Player[], onDone: (msg: string) => void) {
  const text = buildResultsText(session, players);
  if (navigator.share) {
    try {
      await navigator.share({ title: `${session.name} results`, text });
      return;
    } catch {
      // cancelled or unsupported -- fall through to clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    onDone("Copied results to clipboard!");
  } catch {
    onDone("Couldn't copy — try again.");
  }
}

export default function ParticipantSession() {
  const { id } = useParams();
  const sessionId = Number(id);
  const [session, setSession] = useState<Session | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [matchData, setMatchData] = useState<{ ongoing: Match[]; history: Match[]; suggested: Match[]; queued: Match[] }>({
    ongoing: [],
    history: [],
    suggested: [],
    queued: [],
  });
  const [toast, setToast] = useState<string | null>(null);
  const wasOnCourt = useRef(false);
  const lastThreshold = useRef<"none" | "soon" | "next">("none");

  const myId = Number(localStorage.getItem(playerKey(sessionId))) || null;
  const isEnded = session?.status === "ended";
  const [tab, setTab] = useState<Tab>(isEnded ? "ranking" : "dashboard");

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [sessionId]);

  useEffect(() => {
    if (isEnded && (tab === "dashboard" || tab === "ongoing" || tab === "queue")) setTab("ranking");
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
    checkStatus(m.ongoing, m.queued);
  }

  // Now that the actual queue is a real, host-curated order (not just a computer
  // guess), a predictive "you're up soon" notice is reliable again -- alongside the
  // confirmatory "you're on court now" one for the moment it actually happens.
  function checkStatus(ongoing: Match[], queued: Match[]) {
    if (!myId) return;
    const myMatch = ongoing.find((m) => [...m.team1, ...m.team2].includes(myId));
    const isOnCourtNow = !!myMatch;
    if (isOnCourtNow && !wasOnCourt.current) {
      fireNotification(`You're on ${myMatch!.courtLabel} — head to the court!`);
    }
    wasOnCourt.current = isOnCourtNow;

    if (isOnCourtNow) {
      lastThreshold.current = "none";
      return;
    }

    const index = queued.findIndex((m) => [...m.team1, ...m.team2].includes(myId));
    let threshold: "none" | "soon" | "next" = "none";
    if (index === 0) threshold = "next";
    else if (index >= 1 && index < 3) threshold = "soon";

    if (threshold !== "none" && threshold !== lastThreshold.current) {
      if (threshold === "next") fireNotification("You're up next — head toward the courts!");
      else fireNotification("You're up soon — get ready!");
    }
    lastThreshold.current = threshold;
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

      {tab === "dashboard" && me && <DashboardTab player={me} players={players} onChanged={load} />}
      {tab === "ongoing" && <OngoingTab matches={matchData.ongoing} playerById={playerById} myId={myId} />}
      {tab === "queue" && <QueueTab queued={matchData.queued} playerById={playerById} myId={myId} />}
      {tab === "ranking" && (
        <RankingTab session={session} players={players.filter((p) => p.approved)} history={matchData.history} />
      )}
      {tab === "history" && <HistoryTab history={matchData.history} playerById={playerById} />}

      <nav className="tabs">
        {!isEnded && <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>🏠 Dashboard</button>}
        {!isEnded && <button className={tab === "ongoing" ? "active" : ""} onClick={() => setTab("ongoing")}>🏸 Courts</button>}
        {!isEnded && <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>⏳ Queue</button>}
        <button className={tab === "ranking" ? "active" : ""} onClick={() => setTab("ranking")}>🏆 Ranking</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>📜 History</button>
      </nav>
    </div>
  );
}

function DashboardTab({
  player,
  players,
  onChanged,
}: {
  player: Player;
  players: Player[];
  onChanged: () => void;
}) {
  const winPct = player.gamesPlayed ? Math.round((player.wins / player.gamesPlayed) * 100) : 0;
  const others = players
    .filter((p) => p.approved && p.id !== player.id)
    .sort((a, b) => a.name.localeCompare(b.name));

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
      <div className="card">
        <label>Preferred partner</label>
        <select
          value={player.preferredPartnerId ?? ""}
          onChange={async (e) => {
            const v = e.target.value ? Number(e.target.value) : null;
            await api.updatePlayer(player.id, { preferredPartnerId: v });
            onChanged();
          }}
        >
          <option value="">No preference</option>
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
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
            <div className="court-label">
              {m.courtLabel} · started {timeAgo(m.startedAt)}
            </div>
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

function QueueTab({
  queued,
  playerById,
  myId,
}: {
  queued: Match[];
  playerById: (id: number) => Player | undefined;
  myId: number | null;
}) {
  return (
    <div className="stack">
      {queued.map((m, i) => {
        const mine = [...m.team1, ...m.team2].includes(myId ?? -1);
        return (
          <div key={m.id} className="match-card" style={mine ? { borderColor: "var(--accent)" } : undefined}>
            <div className="court-label">Up #{i + 1}</div>
            <div className="team-row">
              <span>{m.team1.map((id) => playerById(id)?.name ?? "?").join(" & ")}</span>
            </div>
            <div className="team-row">
              <span>{m.team2.map((id) => playerById(id)?.name ?? "?").join(" & ")}</span>
            </div>
          </div>
        );
      })}
      {queued.length === 0 && <div className="empty-state">No matches queued right now.</div>}
    </div>
  );
}

function RankingTab({ session, players, history }: { session: Session; players: Player[]; history: Match[] }) {
  const sorted = [...players].sort(rankCompare);
  const top3 = sorted.slice(0, 3);
  const rest = sorted.slice(3);
  const awards = session.status === "ended" ? buildAwards(players, history) : null;
  const [shareMsg, setShareMsg] = useState("");

  function handleShare() {
    shareResults(session, players, (msg) => {
      setShareMsg(msg);
      setTimeout(() => setShareMsg(""), 3000);
    });
  }

  return (
    <div>
      <div className="row between" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>{shareMsg || " "}</div>
        <button className="btn small" onClick={handleShare} disabled={sorted.length === 0}>
          Share results
        </button>
      </div>

      {awards && <AwardsPanel awards={awards} />}

      {top3.length > 0 && <Podium top3={top3} />}
      {rest.length > 0 && (
        <div className="table-wrap">
          <table className="ranking">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>W-L</th>
                <th>Win%</th>
                <th>Diff</th>
              </tr>
            </thead>
            <tbody>
              {rest.map((p, i) => {
                const avgDiff = p.gamesPlayed ? (p.pointsFor - p.pointsAgainst) / p.gamesPlayed : 0;
                const avgDiffLabel = avgDiff.toFixed(1);
                return (
                  <tr key={p.id}>
                    <td>{i + 4}</td>
                    <td>
                      {p.name} {p.currentStreak >= 3 && <span title={`${p.currentStreak}-win streak`}>🔥</span>}{" "}
                      <span style={{ color: "var(--muted)" }}>{LEVEL_ICON[p.level]}</span>
                    </td>
                    <td>{p.wins}-{p.losses}</td>
                    <td>{p.gamesPlayed ? Math.round((p.wins / p.gamesPlayed) * 100) : 0}%</td>
                    <td style={{ color: avgDiff > 0 ? "var(--good)" : avgDiff < 0 ? "var(--bad)" : "var(--muted)" }}>
                      {avgDiff > 0 ? `+${avgDiffLabel}` : avgDiffLabel}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sorted.length === 0 && <div className="empty-state">No ranked players yet.</div>}
    </div>
  );
}

function AwardsPanel({ awards }: { awards: NonNullable<ReturnType<typeof buildAwards>> }) {
  const diffVal = (awards.bestDiff.pointsFor - awards.bestDiff.pointsAgainst) / awards.bestDiff.gamesPlayed;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 15, color: "var(--accent-2)", marginTop: 0 }}>🏆 Session awards</h3>
      <div className="stack">
        <div className="row between">
          <span>🎽 Most games played</span>
          <strong>{awards.mostGames.name} ({awards.mostGames.gamesPlayed})</strong>
        </div>
        <div className="row between">
          <span>📈 Best point diff</span>
          <strong>{awards.bestDiff.name} ({diffVal > 0 ? "+" : ""}{diffVal.toFixed(1)})</strong>
        </div>
        {awards.streakPlayer && awards.streakValue >= 2 && (
          <div className="row between">
            <span>🔥 Longest win streak</span>
            <strong>{awards.streakPlayer.name} ({awards.streakValue})</strong>
          </div>
        )}
      </div>
    </div>
  );
}

function Podium({ top3 }: { top3: Player[] }) {
  const [first, second, third] = top3;
  return (
    <div className="podium">
      <PodiumPlace place={2} player={second} />
      <PodiumPlace place={1} player={first} />
      <PodiumPlace place={3} player={third} />
    </div>
  );
}

function PodiumPlace({ place, player }: { place: 1 | 2 | 3; player?: Player }) {
  if (!player) return <div className="podium-place" />;
  const rankClass = place === 1 ? "gold" : place === 2 ? "silver" : "bronze";
  const winPct = player.gamesPlayed ? Math.round((player.wins / player.gamesPlayed) * 100) : 0;
  return (
    <div className={`podium-place ${rankClass}`}>
      {place === 1 && <div className="podium-crown">👑</div>}
      <div className="podium-avatar">{LEVEL_ICON[player.level]}</div>
      <div className="podium-name">
        {player.name} {player.currentStreak >= 3 && <span title={`${player.currentStreak}-win streak`}>🔥</span>}
      </div>
      <div className="podium-record">{player.wins}-{player.losses} · {winPct}%</div>
      <div className="podium-stand">{place}</div>
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
