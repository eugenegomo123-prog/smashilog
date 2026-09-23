import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, LEVELS, LEVEL_ICON, LEVEL_LABEL, type Session, type Player, type Match, type Level } from "../api";

type Tab = "players" | "courts" | "queue" | "ranking" | "history" | "settings";

export default function HostSession() {
  const { id } = useParams();
  const sessionId = Number(id);
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("players");
  const [session, setSession] = useState<Session | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [matchData, setMatchData] = useState<{ ongoing: Match[]; history: Match[]; suggested: Match[] }>({
    ongoing: [],
    history: [],
    suggested: [],
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
          ongoing={matchData.ongoing}
          players={players}
          playerById={playerById}
          sessionId={sessionId}
          onChanged={load}
        />
      )}
      {tab === "ranking" && <RankingTab players={players.filter((p) => p.approved)} />}
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
  const approved = players.filter((p) => p.approved);

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
      <div className="stack">
        {approved.map((p) => (
          <div key={p.id} className="card">
            <div className="row between">
              <div className="row">
                <div className="level-pill" title={LEVEL_LABEL[p.level]}>{LEVEL_ICON[p.level]}</div>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {LEVEL_LABEL[p.level]} · {p.wins}W-{p.losses}L · {p.gamesPlayed} games
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
            {label} — open · assign a match from the Queue tab
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

  async function submit() {
    if (score1 === "" || score2 === "") return;
    setSubmitting(true);
    try {
      await api.submitScore(match.id, Number(score1), Number(score2));
      await onChanged();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="match-card">
      <div className="court-label">{match.courtLabel}</div>
      <TeamLine ids={match.team1} playerById={playerById} />
      <TeamLine ids={match.team2} playerById={playerById} />
      <div className="row" style={{ marginTop: 10 }}>
        <input placeholder="Score 1" value={score1} onChange={(e) => setScore1(e.target.value)} inputMode="numeric" />
        <input placeholder="Score 2" value={score2} onChange={(e) => setScore2(e.target.value)} inputMode="numeric" />
        <button className="btn small primary" onClick={submit} disabled={submitting}>
          End
        </button>
      </div>
    </div>
  );
}

function TeamLine({ ids, playerById }: { ids: number[]; playerById: (id: number) => Player | undefined }) {
  return (
    <div className="team-row">
      <span>{ids.map((id) => playerById(id)?.name ?? "?").join(" & ")}</span>
    </div>
  );
}

function QueueTab({
  session,
  suggested,
  ongoing,
  players,
  playerById,
  sessionId,
  onChanged,
}: {
  session: Session;
  suggested: Match[];
  ongoing: Match[];
  players: Player[];
  playerById: (id: number) => Player | undefined;
  sessionId: number;
  onChanged: () => void;
}) {
  const [regenerating, setRegenerating] = useState(false);
  const openCourts = session.courtLabels.filter((label) => !ongoing.some((m) => m.courtLabel === label));

  return (
    <div>
      <div className="row between" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          {suggested.length} suggested match{suggested.length === 1 ? "" : "es"} · {openCourts.length} open court
          {openCourts.length === 1 ? "" : "s"}
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

      <div className="stack">
        {suggested.map((m) => (
          <SuggestionCard
            key={m.id}
            match={m}
            openCourts={openCourts}
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

      <h3 style={{ fontSize: 15, color: "var(--muted)", marginTop: 28 }}>Build a custom match</h3>
      <CustomMatchBuilder
        players={players}
        ongoing={ongoing}
        openCourts={openCourts}
        sessionId={sessionId}
        onChanged={onChanged}
      />
    </div>
  );
}

function SuggestionCard({
  match,
  openCourts,
  playerById,
  sessionId,
  onChanged,
}: {
  match: Match;
  openCourts: string[];
  playerById: (id: number) => Player | undefined;
  sessionId: number;
  onChanged: () => void;
}) {
  const [court, setCourt] = useState(openCourts[0] ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!openCourts.includes(court)) setCourt(openCourts[0] ?? "");
  }, [openCourts.join(",")]);

  async function send() {
    if (!court) return;
    setSending(true);
    setError("");
    try {
      await api.assignMatch(sessionId, match.id, court);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send this match");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="match-card">
      <TeamLine ids={match.team1} playerById={playerById} />
      <TeamLine ids={match.team2} playerById={playerById} />
      {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <select value={court} onChange={(e) => setCourt(e.target.value)} disabled={openCourts.length === 0}>
          {openCourts.length === 0 && <option value="">No open courts</option>}
          {openCourts.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
        <button className="btn small primary" onClick={send} disabled={sending || !court}>
          Send
        </button>
      </div>
    </div>
  );
}

function CustomMatchBuilder({
  players,
  ongoing,
  openCourts,
  sessionId,
  onChanged,
}: {
  players: Player[];
  ongoing: Match[];
  openCourts: string[];
  sessionId: number;
  onChanged: () => void;
}) {
  const busy = new Set(ongoing.flatMap((m) => [...m.team1, ...m.team2]));
  const eligible = players.filter((p) => p.approved && p.status === "active" && !busy.has(p.id));

  const [team1a, setTeam1a] = useState<number | "">("");
  const [team1b, setTeam1b] = useState<number | "">("");
  const [team2a, setTeam2a] = useState<number | "">("");
  const [team2b, setTeam2b] = useState<number | "">("");
  const [court, setCourt] = useState(openCourts[0] ?? "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const chosen = [team1a, team1b, team2a, team2b];

  function optionsFor(current: number | "") {
    return eligible.filter((p) => p.id === current || !chosen.includes(p.id));
  }

  function pillSelect(value: number | "", onChange: (v: number | "") => void, label: string) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : "")}>
        <option value="">{label}</option>
        {optionsFor(value).map((p) => (
          <option key={p.id} value={p.id}>
            {LEVEL_ICON[p.level]} {p.name}
          </option>
        ))}
      </select>
    );
  }

  async function createMatch() {
    setError("");
    if (team1a === "" || team1b === "" || team2a === "" || team2b === "" || !court) {
      setError("Pick 4 different players and a court.");
      return;
    }
    setSubmitting(true);
    try {
      await api.createCustomMatch(sessionId, court, [team1a, team1b], [team2a, team2b]);
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
      <label style={{ marginTop: 12 }}>Court</label>
      <div className="row">
        <select value={court} onChange={(e) => setCourt(e.target.value)} disabled={openCourts.length === 0}>
          {openCourts.length === 0 && <option value="">No open courts</option>}
          {openCourts.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
        <button className="btn primary" onClick={createMatch} disabled={submitting || openCourts.length === 0}>
          Create match
        </button>
      </div>
      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      {eligible.length < 4 && (
        <div className="empty-state" style={{ padding: "12px 0 0" }}>
          Need at least 4 active, unassigned players to build a custom match.
        </div>
      )}
    </div>
  );
}

function rankCompare(a: Player, b: Player) {
  if (b.wins !== a.wins) return b.wins - a.wins;
  const wpA = a.gamesPlayed ? a.wins / a.gamesPlayed : 0;
  const wpB = b.gamesPlayed ? b.wins / b.gamesPlayed : 0;
  if (wpB !== wpA) return wpB - wpA;
  if (a.losses !== b.losses) return a.losses - b.losses;
  return a.name.localeCompare(b.name);
}

function RankingTab({ players }: { players: Player[] }) {
  const sorted = [...players].sort(rankCompare);
  const top3 = sorted.slice(0, 3);
  const rest = sorted.slice(3);

  return (
    <div>
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
                const diff = p.pointsFor - p.pointsAgainst;
                return (
                  <tr key={p.id}>
                    <td>{i + 4}</td>
                    <td>{p.name} <span style={{ color: "var(--muted)" }}>{LEVEL_ICON[p.level]}</span></td>
                    <td>{p.wins}-{p.losses}</td>
                    <td>{p.gamesPlayed ? Math.round((p.wins / p.gamesPlayed) * 100) : 0}%</td>
                    <td style={{ color: diff > 0 ? "var(--good)" : diff < 0 ? "var(--bad)" : "var(--muted)" }}>
                      {diff > 0 ? `+${diff}` : diff}
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
      <div className="podium-name">{player.name}</div>
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
          <button
            className="btn small primary"
            onClick={async () => {
              await api.submitScore(match.id, Number(score1), Number(score2));
              setEditing(false);
              onChanged();
            }}
          >
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

  return (
    <div className="stack">
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
