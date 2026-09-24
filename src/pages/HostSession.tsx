import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, LEVELS, LEVEL_ICON, LEVEL_LABEL, type Session, type Player, type Match, type Level } from "../api";

type Tab = "players" | "courts" | "queue" | "ranking" | "history" | "settings";

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

// Players eligible to appear in a new suggestion or custom match: approved, active,
// and not already on a court or already sitting in the actual queue.
function eligiblePoolFor(players: Player[], ongoing: Match[], queued: Match[]): Player[] {
  const busy = new Set([...ongoing, ...queued].flatMap((m) => [...m.team1, ...m.team2]));
  return players.filter((p) => p.approved && p.status === "active" && !busy.has(p.id));
}

function isStale(match: Match, pool: Player[]): boolean {
  const ids = [...match.team1, ...match.team2];
  return ids.some((id) => !pool.some((p) => p.id === id));
}

function suggestionReason(match: Match, pool: Player[]): string {
  const ids = [...match.team1, ...match.team2];
  const involved = pool.filter((p) => ids.includes(p.id));
  if (involved.length === 0) return "Balanced pick from the active pool";
  const minGames = Math.min(...pool.map((p) => p.gamesPlayed));
  if (involved.some((p) => p.gamesPlayed === minGames)) return "Includes a least-played player";
  if (involved.some((p) => !p.lastMatchEndedAt)) return "Includes a player who hasn't played yet";
  const rested = pool.filter((p) => p.lastMatchEndedAt);
  if (rested.length > 0) {
    const oldest = Math.min(...rested.map((p) => new Date(p.lastMatchEndedAt as string).getTime()));
    if (involved.some((p) => p.lastMatchEndedAt && new Date(p.lastMatchEndedAt).getTime() === oldest)) {
      return "Includes the most-rested player";
    }
  }
  return "Balanced pick from the active pool";
}

// Players who were in the single most-recently-completed match (history is already
// sorted newest-first by the API).
function justPlayedIds(history: Match[]): Set<number> {
  if (history.length === 0) return new Set();
  const mostRecent = history[0];
  return new Set([...mostRecent.team1, ...mostRecent.team2]);
}

// Players who've played noticeably fewer games than the busiest player currently in
// the pool -- a stand-in for "has been sitting out a while," since the app doesn't
// track discrete rounds/rotations directly.
function restingLongIds(pool: Player[]): Set<number> {
  if (pool.length === 0) return new Set();
  const maxGames = Math.max(...pool.map((p) => p.gamesPlayed));
  return new Set(pool.filter((p) => maxGames - p.gamesPlayed >= 2).map((p) => p.id));
}

export default function HostSession() {
  const { id } = useParams();
  const sessionId = Number(id);
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("players");
  const [session, setSession] = useState<Session | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [matchData, setMatchData] = useState<{ ongoing: Match[]; history: Match[]; suggested: Match[]; queued: Match[] }>({
    ongoing: [],
    history: [],
    suggested: [],
    queued: [],
  });
  const [error, setError] = useState("");

  useEffect(() => {
    if (!api.isHost()) {
      navigate("/host");
      return;
    }
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [sessionId]);

  async function load() {
    try {
      const [s, p, m] = await Promise.all([
        api.getSession(sessionId),
        api.listPlayers(sessionId),
        api.getMatches(sessionId),
      ]);
      setSession(s);
      setPlayers(p);
      setMatchData(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session");
    }
  }

  const playerById = (pid: number) => players.find((p) => p.id === pid);

  if (!session) return <div className="screen empty-state">{error || "Loading…"}</div>;

  const pending = players.filter((p) => !p.approved);

  return (
    <div className="screen">
      <a className="back-link" href="/host/sessions">
        ← All sessions
      </a>
      <div className="brand row between">
        <h1>{session.name}</h1>
        <span className={`badge ${session.status === "active" ? "active" : "ended"}`}>{session.status}</span>
      </div>
      <p className="subtitle">
        {session.courtCount} courts · {players.filter((p) => p.approved).length} players
      </p>
      {error && <div className="error-text">{error}</div>}

      {tab === "players" && (
        <PlayersTab
          session={session}
          players={players}
          pending={pending}
          onChanged={load}
        />
      )}
      {tab === "courts" && (
        <CourtsTab session={session} ongoing={matchData.ongoing} playerById={playerById} onChanged={load} />
      )}
      {tab === "queue" && (
        <QueueTab
          session={session}
          suggested={matchData.suggested}
          queued={matchData.queued}
          ongoing={matchData.ongoing}
          history={matchData.history}
          players={players}
          playerById={playerById}
          sessionId={sessionId}
          onChanged={load}
        />
      )}
      {tab === "ranking" && (
        <RankingTab session={session} players={players.filter((p) => p.approved)} history={matchData.history} />
      )}
      {tab === "history" && <HistoryTab history={matchData.history} playerById={playerById} onChanged={load} />}
      {tab === "settings" && <SettingsTab session={session} onChanged={load} />}

      <nav className="tabs">
        <TabButton active={tab === "players"} onClick={() => setTab("players")} label="🧑‍🤝‍🧑 Players" badge={pending.length} />
        <TabButton active={tab === "courts"} onClick={() => setTab("courts")} label="🏸 Courts" />
        <TabButton active={tab === "queue"} onClick={() => setTab("queue")} label="⏳ Queue" />
        <TabButton active={tab === "ranking"} onClick={() => setTab("ranking")} label="🏆 Ranking" />
        <TabButton active={tab === "history"} onClick={() => setTab("history")} label="📜 History" />
        <TabButton active={tab === "settings"} onClick={() => setTab("settings")} label="⚙️ Settings" />
      </nav>
    </div>
  );
}

function TabButton({ active, onClick, label, badge }: { active: boolean; onClick: () => void; label: string; badge?: number }) {
  return (
    <button className={active ? "active" : ""} onClick={onClick}>
      {label}
      {!!badge && <span className="badge pending" style={{ marginLeft: 4 }}>{badge}</span>}
    </button>
  );
}

function PlayersTab({
  players,
  pending,
  onChanged,
}: {
  session: Session;
  players: Player[];
  pending: Player[];
  onChanged: () => void;
}) {
  const { id } = useParams();
  const sessionId = Number(id);
  const [name, setName] = useState("");
  const [level, setLevel] = useState<Level>("C");
  const [search, setSearch] = useState("");
  const approved = [...players.filter((p) => p.approved)].sort((a, b) => a.name.localeCompare(b.name));
  const filteredApproved = approved.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()));

  async function addPlayer(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await api.addPlayer(sessionId, name.trim(), level);
    setName("");
    onChanged();
  }

  return (
    <div>
      {pending.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, color: "var(--accent)" }}>Pending join requests</h3>
          <div className="stack">
            {pending.map((p) => (
              <div key={p.id} className="card row between">
                <div>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>
                    Requested level {p.requestedLevel ? `${LEVEL_ICON[p.requestedLevel]} ` : ""}{p.requestedLevel}
                  </div>
                </div>
                <div className="row">
                  <button
                    className="btn small primary"
                    onClick={async () => {
                      await api.updatePlayer(p.id, { approved: true, level: p.requestedLevel ?? "C" });
                      onChanged();
                    }}
                  >
                    Approve
                  </button>
                  <button
                    className="btn small danger"
                    onClick={async () => {
                      await api.removePlayer(p.id);
                      onChanged();
                    }}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h3 style={{ fontSize: 15, color: "var(--muted)", marginTop: pending.length ? 24 : 0 }}>Add a player</h3>
      <form className="card row" onSubmit={addPlayer}>
        <input placeholder="Player name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={level} onChange={(e) => setLevel(e.target.value as Level)} style={{ width: 110 }}>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {LEVEL_ICON[l]} {l}
            </option>
          ))}
        </select>
        <button className="btn primary" type="submit">
          Add
        </button>
      </form>

      <h3 style={{ fontSize: 15, color: "var(--muted)", marginTop: 24 }}>Roster ({approved.length})</h3>
      <input
        placeholder="Search players…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 12 }}
      />
      <div className="stack">
        {filteredApproved.map((p) => (
          <div key={p.id} className="card">
            <div className="row between">
              <div className="row">
                <div className="level-pill" title={LEVEL_LABEL[p.level]}>{LEVEL_ICON[p.level]}</div>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {LEVEL_LABEL[p.level]} · {p.wins}W-{p.losses}L · {p.gamesPlayed} games
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>
                    {p.lastMatchEndedAt ? `Last played ${timeAgo(p.lastMatchEndedAt)}` : "Hasn't played yet"}
                    {p.preferredPartnerId &&
                      ` · wants ${players.find((x) => x.id === p.preferredPartnerId)?.name ?? "a partner"}`}
                  </div>
                </div>
              </div>
              <span className={`badge ${p.status}`}>{p.status}</span>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <select
                value={p.level}
                onChange={async (e) => {
                  await api.updatePlayer(p.id, { level: e.target.value as Level });
                  onChanged();
                }}
              >
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {LEVEL_ICON[l]} {l} · {LEVEL_LABEL[l]}
                  </option>
                ))}
              </select>
              <select
                value={p.status}
                onChange={async (e) => {
                  await api.updatePlayer(p.id, { status: e.target.value as Player["status"] });
                  onChanged();
                }}
              >
                <option value="active">Active</option>
                <option value="resting">Resting</option>
                <option value="inactive">Inactive</option>
              </select>
              <button
                className="btn small danger"
                onClick={async () => {
                  await api.removePlayer(p.id);
                  onChanged();
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {approved.length === 0 && <div className="empty-state">No players yet.</div>}
        {approved.length > 0 && filteredApproved.length === 0 && (
          <div className="empty-state">No players match "{search}".</div>
        )}
      </div>
    </div>
  );
}

function CourtsTab({
  session,
  ongoing,
  playerById,
  onChanged,
}: {
  session: Session;
  ongoing: Match[];
  playerById: (id: number) => Player | undefined;
  onChanged: () => void;
}) {
  const emptyCourts = session.courtLabels.filter((label) => !ongoing.some((m) => m.courtLabel === label));

  return (
    <div>
      <div className="row between" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          {ongoing.length} of {session.courtCount} courts in play
        </div>
      </div>
      <div className="stack">
        {ongoing.map((m) => (
          <ScoreCard key={m.id} match={m} playerById={playerById} onChanged={onChanged} />
        ))}
        {emptyCourts.map((label) => (
          <div key={label} className="match-card empty-state">
            {label} — open · fills automatically from the queue
          </div>
        ))}
      </div>
    </div>
  );
}

function ScoreCard({
  match,
  playerById,
  onChanged,
}: {
  match: Match;
  playerById: (id: number) => Player | undefined;
  onChanged: () => void;
}) {
  const [score1, setScore1] = useState("");
  const [score2, setScore2] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function submit() {
    if (score1 === "" || score2 === "") return;
    if (Number(score1) === Number(score2)) {
      if (!confirm("Scores are tied — is that right? Badminton games don't usually end in a tie.")) return;
    }
    setSubmitting(true);
    try {
      await api.submitScore(match.id, Number(score1), Number(score2));
      await onChanged();
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    if (!confirm("Remove this match without recording a score? The court and players will be freed up.")) return;
    setRemoving(true);
    try {
      await api.deleteMatch(match.id);
      await onChanged();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="match-card">
      <div className="court-label">
        {match.courtLabel} · started {timeAgo(match.startedAt)}
      </div>
      <TeamLine ids={match.team1} playerById={playerById} />
      <TeamLine ids={match.team2} playerById={playerById} />
      <div className="row" style={{ marginTop: 10 }}>
        <input placeholder="Score 1" value={score1} onChange={(e) => setScore1(e.target.value)} inputMode="numeric" />
        <input placeholder="Score 2" value={score2} onChange={(e) => setScore2(e.target.value)} inputMode="numeric" />
        <button className="btn small primary" onClick={submit} disabled={submitting}>
          End
        </button>
      </div>
      <button className="btn small danger" style={{ marginTop: 8 }} onClick={remove} disabled={removing}>
        {removing ? "Removing…" : "Remove match"}
      </button>
    </div>
  );
}

function TeamLine({
  ids,
  playerById,
  justPlayed,
  restingLong,
}: {
  ids: number[];
  playerById: (id: number) => Player | undefined;
  justPlayed?: Set<number>;
  restingLong?: Set<number>;
}) {
  return (
    <div className="team-row">
      <span>
        {ids
          .map((id) => {
            const name = playerById(id)?.name ?? "?";
            const flags = `${justPlayed?.has(id) ? " 🥵" : ""}${restingLong?.has(id) ? " ⏳" : ""}`;
            return name + flags;
          })
          .join(" & ")}
      </span>
    </div>
  );
}

function QueueTab({
  session,
  suggested,
  queued,
  ongoing,
  history,
  players,
  playerById,
  sessionId,
  onChanged,
}: {
  session: Session;
  suggested: Match[];
  queued: Match[];
  ongoing: Match[];
  history: Match[];
  players: Player[];
  playerById: (id: number) => Player | undefined;
  sessionId: number;
  onChanged: () => void;
}) {
  const [regenerating, setRegenerating] = useState(false);
  const pool = eligiblePoolFor(players, ongoing, queued);
  const anyStale = suggested.some((m) => isStale(m, pool));
  const justPlayed = justPlayedIds(history);
  const restingLong = restingLongIds(pool);
  const queueFull = queued.length >= 8;

  return (
    <div>
      <div className="row between" style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          {suggested.length} suggested · {queued.length}/8 queued
        </div>
        <button
          className="btn small"
          disabled={regenerating}
          onClick={async () => {
            setRegenerating(true);
            await api.regenerateSuggestions(sessionId);
            await onChanged();
            setRegenerating(false);
          }}
        >
          {regenerating ? "Regenerating…" : "Regenerate"}
        </button>
      </div>

      {anyStale && (
        <div className="error-text" style={{ marginBottom: 12 }}>
          Some suggested matches include players who are no longer available — Regenerate to refresh.
        </div>
      )}

      <h3 style={{ fontSize: 15, color: "var(--muted)" }}>Suggested matches</h3>
      <div className="stack">
        {suggested.map((m) => (
          <SuggestionCard
            key={m.id}
            match={m}
            pool={pool}
            justPlayed={justPlayed}
            restingLong={restingLong}
            queueFull={queueFull}
            playerById={playerById}
            sessionId={sessionId}
            onChanged={onChanged}
          />
        ))}
        {suggested.length === 0 && (
          <div className="empty-state">
            No suggested matches yet — press Regenerate to build some from the active roster.
          </div>
        )}
      </div>

      <h3 style={{ fontSize: 15, color: "var(--muted)", marginTop: 24 }}>Build a custom match</h3>
      <CustomMatchBuilder
        players={players}
        ongoing={ongoing}
        queued={queued}
        justPlayed={justPlayed}
        restingLong={restingLong}
        queueFull={queueFull}
        sessionId={sessionId}
        onChanged={onChanged}
      />

      <h3 style={{ fontSize: 15, color: "var(--muted)", marginTop: 24 }}>Actual queue ({queued.length}/8)</h3>
      <p className="subtitle" style={{ marginBottom: 12 }}>
        First in line takes the next court that opens up. Participants see this list — reorder or remove below.
      </p>
      <ActualQueueSection queued={queued} playerById={playerById} sessionId={sessionId} onChanged={onChanged} />
    </div>
  );
}

function SuggestionCard({
  match,
  pool,
  justPlayed,
  restingLong,
  queueFull,
  playerById,
  sessionId,
  onChanged,
}: {
  match: Match;
  pool: Player[];
  justPlayed: Set<number>;
  restingLong: Set<number>;
  queueFull: boolean;
  playerById: (id: number) => Player | undefined;
  sessionId: number;
  onChanged: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const stale = isStale(match, pool);
  const reason = stale ? null : suggestionReason(match, pool);

  async function addToQueue() {
    setSending(true);
    setError("");
    try {
      await api.assignMatch(sessionId, match.id);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this match");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="match-card">
      <TeamLine ids={match.team1} playerById={playerById} justPlayed={justPlayed} restingLong={restingLong} />
      <TeamLine ids={match.team2} playerById={playerById} justPlayed={justPlayed} restingLong={restingLong} />
      <div style={{ fontSize: 12, color: stale ? "var(--bad)" : "var(--muted)", marginTop: 4 }}>
        {stale ? "⚠️ Includes a player who's no longer available" : reason}
      </div>
      {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
      <button className="btn small primary" style={{ marginTop: 10 }} onClick={addToQueue} disabled={sending || queueFull}>
        {queueFull ? "Queue is full" : "Add to queue"}
      </button>
    </div>
  );
}

function CustomMatchBuilder({
  players,
  ongoing,
  queued,
  justPlayed,
  restingLong,
  queueFull,
  sessionId,
  onChanged,
}: {
  players: Player[];
  ongoing: Match[];
  queued: Match[];
  justPlayed: Set<number>;
  restingLong: Set<number>;
  queueFull: boolean;
  sessionId: number;
  onChanged: () => void;
}) {
  const busy = new Set([...ongoing, ...queued].flatMap((m) => [...m.team1, ...m.team2]));
  const eligible = players
    .filter((p) => p.approved && p.status === "active" && !busy.has(p.id))
    .sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.name.localeCompare(b.name));

  const [team1a, setTeam1a] = useState<number | "">("");
  const [team1b, setTeam1b] = useState<number | "">("");
  const [team2a, setTeam2a] = useState<number | "">("");
  const [team2b, setTeam2b] = useState<number | "">("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const chosen = [team1a, team1b, team2a, team2b];

  function optionsFor(current: number | "") {
    return eligible.filter((p) => p.id === current || !chosen.includes(p.id));
  }

  function flagsFor(id: number) {
    return `${justPlayed.has(id) ? " 🥵" : ""}${restingLong.has(id) ? " ⏳" : ""}`;
  }

  function pillSelect(value: number | "", onChange: (v: number | "") => void, label: string) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : "")}>
        <option value="">{label}</option>
        {optionsFor(value).map((p) => (
          <option key={p.id} value={p.id}>
            {LEVEL_ICON[p.level]} {p.name} · {p.gamesPlayed}g{flagsFor(p.id)}
          </option>
        ))}
      </select>
    );
  }

  async function createMatch() {
    setError("");
    if (team1a === "" || team1b === "" || team2a === "" || team2b === "") {
      setError("Pick 4 different players.");
      return;
    }
    setSubmitting(true);
    try {
      await api.createCustomMatch(sessionId, [team1a, team1b], [team2a, team2b]);
      setTeam1a("");
      setTeam1b("");
      setTeam2a("");
      setTeam2b("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create this match");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <label>Team 1</label>
      <div className="row">
        {pillSelect(team1a, setTeam1a, "Player A")}
        {pillSelect(team1b, setTeam1b, "Player B")}
      </div>
      <label style={{ marginTop: 12 }}>Team 2</label>
      <div className="row">
        {pillSelect(team2a, setTeam2a, "Player A")}
        {pillSelect(team2b, setTeam2b, "Player B")}
      </div>
      <button
        className="btn primary"
        style={{ marginTop: 12 }}
        onClick={createMatch}
        disabled={submitting || queueFull}
      >
        {queueFull ? "Queue is full" : "Add to queue"}
      </button>
      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      {eligible.length < 4 && (
        <div className="empty-state" style={{ padding: "12px 0 0" }}>
          Need at least 4 active, unassigned players to build a custom match.
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
        🥵 just played · ⏳ waiting a while
      </div>
    </div>
  );
}

function ActualQueueSection({
  queued,
  playerById,
  sessionId,
  onChanged,
}: {
  queued: Match[];
  playerById: (id: number) => Player | undefined;
  sessionId: number;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);

  async function move(index: number, delta: number) {
    const newIndex = index + delta;
    if (newIndex < 0 || newIndex >= queued.length) return;
    const order = queued.map((m) => m.id);
    [order[index], order[newIndex]] = [order[newIndex], order[index]];
    setBusyId(queued[index].id);
    try {
      await api.reorderQueue(sessionId, order);
      await onChanged();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(matchId: number) {
    setBusyId(matchId);
    try {
      await api.deleteMatch(matchId);
      await onChanged();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="stack">
      {queued.map((m, i) => (
        <div key={m.id} className="match-card">
          <div className="court-label">Up #{i + 1}</div>
          <TeamLine ids={m.team1} playerById={playerById} />
          <TeamLine ids={m.team2} playerById={playerById} />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => move(i, -1)} disabled={i === 0 || busyId === m.id}>
              ▲
            </button>
            <button
              className="btn small"
              onClick={() => move(i, 1)}
              disabled={i === queued.length - 1 || busyId === m.id}
            >
              ▼
            </button>
            <button className="btn small danger" onClick={() => remove(m.id)} disabled={busyId === m.id}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {queued.length === 0 && (
        <div className="empty-state">Queue is empty — add a suggested or custom match above.</div>
      )}
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

function HistoryTab({
  history,
  playerById,
  onChanged,
}: {
  history: Match[];
  playerById: (id: number) => Player | undefined;
  onChanged: () => void;
}) {
  return (
    <div className="stack">
      {history.map((m) => (
        <HistoryCard key={m.id} match={m} playerById={playerById} onChanged={onChanged} />
      ))}
      {history.length === 0 && <div className="empty-state">No completed matches yet.</div>}
    </div>
  );
}

function HistoryCard({
  match,
  playerById,
  onChanged,
}: {
  match: Match;
  playerById: (id: number) => Player | undefined;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [score1, setScore1] = useState(String(match.score1 ?? 0));
  const [score2, setScore2] = useState(String(match.score2 ?? 0));
  const [deleting, setDeleting] = useState(false);

  async function save() {
    if (Number(score1) === Number(score2)) {
      if (!confirm("Scores are tied — is that right? Badminton games don't usually end in a tie.")) return;
    }
    await api.submitScore(match.id, Number(score1), Number(score2));
    setEditing(false);
    onChanged();
  }

  async function remove() {
    if (!confirm("Delete this match from history? Everyone's stats will be recalculated.")) return;
    setDeleting(true);
    try {
      await api.deleteMatch(match.id);
      onChanged();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="match-card">
      <div className="court-label">
        {match.courtLabel} · {new Date(match.endedAt ?? match.startedAt).toLocaleString()}
      </div>
      <div className="team-row">
        <span>{match.team1.map((id) => playerById(id)?.name ?? "?").join(" & ")}</span>
        <strong>{match.score1}</strong>
      </div>
      <div className="team-row">
        <span>{match.team2.map((id) => playerById(id)?.name ?? "?").join(" & ")}</span>
        <strong>{match.score2}</strong>
      </div>
      {editing ? (
        <div className="row" style={{ marginTop: 10 }}>
          <input value={score1} onChange={(e) => setScore1(e.target.value)} inputMode="numeric" />
          <input value={score2} onChange={(e) => setScore2(e.target.value)} inputMode="numeric" />
          <button className="btn small primary" onClick={save}>
            Save
          </button>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn small" onClick={() => setEditing(true)}>
            Edit score
          </button>
          <button className="btn small danger" onClick={remove} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      )}
    </div>
  );
}

function SettingsTab({ session, onChanged }: { session: Session; onChanged: () => void }) {
  const navigate = useNavigate();
  const [courtCount, setCourtCount] = useState(session.courtCount);
  const [copied, setCopied] = useState(false);
  const joinUrl = `${window.location.origin}/join/${session.id}`;
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(joinUrl)}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <div className="stack">
      <div className="card" style={{ textAlign: "center" }}>
        <label style={{ textAlign: "left" }}>Join link</label>
        <img
          src={qrSrc}
          alt="QR code to join this session"
          width={180}
          height={180}
          style={{ borderRadius: 12, margin: "8px auto", display: "block" }}
        />
        <div style={{ fontSize: 13, color: "var(--muted)", wordBreak: "break-all", marginBottom: 10 }}>{joinUrl}</div>
        <button className="btn small" onClick={copyLink}>
          {copied ? "Copied!" : "Copy link"}
        </button>
      </div>

      <div className="card">
        <label>Number of courts</label>
        <div className="row">
          <input type="number" min={1} max={20} value={courtCount} onChange={(e) => setCourtCount(Number(e.target.value))} />
          <button
            className="btn primary"
            onClick={async () => {
              const labels = Array.from({ length: courtCount }, (_, i) => session.courtLabels[i] ?? `Court #${i + 1}`);
              await api.updateSession(session.id, { courtCount, courtLabels: labels });
              onChanged();
            }}
          >
            Save
          </button>
        </div>
      </div>

      <div className="card">
        <label>Court names</label>
        <div className="stack">
          {session.courtLabels.map((label, i) => (
            <input
              key={i}
              defaultValue={label}
              onBlur={async (e) => {
                const labels = [...session.courtLabels];
                labels[i] = e.target.value || label;
                await api.updateSession(session.id, { courtLabels: labels });
                onChanged();
              }}
            />
          ))}
        </div>
      </div>

      <div className="card stack">
        {session.status === "active" ? (
          <button
            className="btn"
            onClick={async () => {
              await api.updateSession(session.id, { status: "ended" });
              onChanged();
            }}
          >
            End session
          </button>
        ) : (
          <button
            className="btn"
            onClick={async () => {
              await api.updateSession(session.id, { status: "active" });
              onChanged();
            }}
          >
            Reopen session
          </button>
        )}
        <button
          className="btn danger"
          onClick={async () => {
            if (!confirm(`Delete "${session.name}" and all its data? This cannot be undone.`)) return;
            await api.deleteSession(session.id);
            navigate("/host/sessions");
          }}
        >
          Delete session
        </button>
      </div>
    </div>
  );
}
