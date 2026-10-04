import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, TIER_BADGE_IMAGE, rankScore } from "../api";

type Tab = "stats" | "rank" | "ranking" | "history" | "account";

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
  pointsAgainst: number;
  averagePointDiff: number;
  highestWinStreak: number;
}

interface JoinableSession {
  id: number;
  name: string;
  playerCount: number;
  alreadyJoined: boolean;
  approved: boolean;
}

interface RatingInfo {
  tier: string;
  division: "I" | "II" | "III" | null;
  provisional: boolean;
  seasonPoints: number;
  ratedGamesPlayed: number;
  currentRatingStreak: number;
  provisionalGamesThreshold: number;
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
      <Link className="back-link" to="/">
        ← Back
      </Link>
      <div className="brand">
        <h1>Hi, {api.playerUsername()}</h1>
      </div>

      {tab === "stats" && <StatsTab />}
      {tab === "rank" && <RankTab />}
      {tab === "ranking" && <RankingTab />}
      {tab === "history" && <HistoryTab />}
      {tab === "account" && <AccountTab />}

      <nav className="tabs">
        <button className={tab === "stats" ? "active" : ""} onClick={() => setTab("stats")}>📊 Stats</button>
        <button className={tab === "rank" ? "active" : ""} onClick={() => setTab("rank")}>🏅 Rank</button>
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

interface AccountRankEntry {
  accountId: number;
  username: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
}

function RankingTab() {
  const [scope, setScope] = useState<string>("all");
  const [entries, setEntries] = useState<AccountRankEntry[] | null>(null);
  const me = api.playerUsername();
  const currentMonth = new Date().toISOString().slice(0, 7);

  useEffect(() => {
    setEntries(null);
    api.getOverallRanking(scope).then(setEntries);
  }, [scope]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 16 }}>
        <button className={`btn ${scope === "all" ? "primary" : ""}`} onClick={() => setScope("all")}>
          All Time
        </button>
        <input
          type="month"
          value={scope !== "all" ? scope : ""}
          max={currentMonth}
          onChange={(e) => e.target.value && setScope(e.target.value)}
        />
      </div>

      {entries === null && <div className="empty-state">Loading…</div>}
      {entries && entries.length === 0 && (
        <div className="empty-state">No games played {scope === "all" ? "yet" : "in that month"}.</div>
      )}
      {entries && entries.length > 0 && (
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
              {entries.map((e, i) => {
                const winPct = e.gamesPlayed ? Math.round((e.wins / e.gamesPlayed) * 100) : 0;
                const avgDiff = e.gamesPlayed ? (e.pointsFor - e.pointsAgainst) / e.gamesPlayed : 0;
                const isMe = e.username === me;
                return (
                  <tr key={e.accountId} style={isMe ? { background: "var(--panel-2)", fontWeight: 700 } : undefined}>
                    <td>{i + 1}</td>
                    <td>
                      <Link to={`/player/${e.accountId}`} style={{ color: "inherit", textDecoration: "underline" }}>
                        {e.username}
                      </Link>
                      {isMe ? " (you)" : ""}
                    </td>
                    <td>{e.wins}-{e.losses}</td>
                    <td>{winPct}%</td>
                    <td style={{ color: avgDiff > 0 ? "var(--good)" : avgDiff < 0 ? "var(--bad)" : "var(--muted)" }}>
                      {avgDiff > 0 ? `+${avgDiff.toFixed(1)}` : avgDiff.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
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
            <span>Average point diff</span>
            <strong style={{ color: stats.averagePointDiff > 0 ? "var(--good)" : stats.averagePointDiff < 0 ? "var(--bad)" : "var(--muted)" }}>
              {stats.averagePointDiff > 0 ? `+${stats.averagePointDiff.toFixed(1)}` : stats.averagePointDiff.toFixed(1)}
            </strong>
          </div>
          <div className="row between">
            <span>Highest win streak</span>
            <strong>{stats.highestWinStreak}</strong>
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

// Dedicated rank/tier tab -- the badge art is drawn to glow on a dark
// background (see .rank-badge-card in styles.css), so it gets its own big,
// centered showcase here rather than the small inline card this used to be
// inside StatsTab.
function RankTab() {
  const [rating, setRating] = useState<RatingInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rankUpMessage, setRankUpMessage] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMyRating()
      .then((r) => {
        setRating(r);

        // Compare against the rank we last showed this player on this device
        // (localStorage, keyed by username) -- if it went up since then,
        // celebrate it. First-ever check just records a baseline silently,
        // so a brand-new player doesn't get "congratulated" on login.
        const key = `smashilog_last_rank_${api.playerUsername() ?? "anon"}`;
        const stored = localStorage.getItem(key);
        const currentScore = rankScore(r.tier, r.division);
        if (stored !== null) {
          const previousScore = Number(stored);
          if (Number.isFinite(previousScore) && currentScore > previousScore) {
            setRankUpMessage(`🎉 You ranked up to ${r.tier}${r.division ? ` ${r.division}` : ""}!`);
          }
        }
        localStorage.setItem(key, String(currentScore));
      })
      .catch(() => setRating(null))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return <div className="empty-state">Loading…</div>;

  if (!rating) {
    return <div className="empty-state">Play a rated match to earn your first rank badge.</div>;
  }

  const badgeSrc = TIER_BADGE_IMAGE[rating.tier] ?? TIER_BADGE_IMAGE.Fledgling;

  return (
    <div className="stack">
      {rankUpMessage && (
        <div className="rank-up-banner">
          <span>{rankUpMessage}</span>
          <button className="rank-up-dismiss" onClick={() => setRankUpMessage(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      <div className="rank-badge-card">
        <img className="rank-badge-image" src={badgeSrc} alt={`${rating.tier} rank badge`} />
        <div style={{ fontWeight: 800, fontSize: 26, color: "#fff", marginTop: 14 }}>
          {rating.tier}
          {rating.division ? ` ${rating.division}` : ""}
        </div>
        {rating.provisional && (
          <div style={{ fontSize: 13, color: "#d8cdbe", marginTop: 4 }}>
            {rating.ratedGamesPlayed < rating.provisionalGamesThreshold
              ? `Still calibrating — ${rating.ratedGamesPlayed} of ${rating.provisionalGamesThreshold} rated games played`
              : "Recalibrating after some time away"}
          </div>
        )}
        {rating.currentRatingStreak >= 3 && (
          <div style={{ fontSize: 14, marginTop: 10, color: "#ffd27a" }}>
            🔥 {rating.currentRatingStreak} win streak
          </div>
        )}
      </div>

      <div className="card row between">
        <span>Season points</span>
        <strong>{rating.seasonPoints}</strong>
      </div>
      <div className="card row between">
        <span>Rated games played</span>
        <strong>{rating.ratedGamesPlayed}</strong>
      </div>
    </div>
  );
}

function HistoryTab() {
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.getMyHistory>> | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    api.getMyHistory().then(setHistory);
  }, []);

  if (selectedId) return <SessionDetailView sessionId={selectedId} onBack={() => setSelectedId(null)} />;
  if (history === null) return <div className="empty-state">Loading…</div>;
  if (history.length === 0) return <div className="empty-state">No past sessions yet.</div>;

  return (
    <div className="stack">
      {history.map((h) => (
        <div
          key={h.sessionId}
          className="card row between"
          style={{ cursor: "pointer" }}
          onClick={() => setSelectedId(h.sessionId)}
        >
          <div>
            <div style={{ fontWeight: 600 }}>{h.sessionName}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              {new Date(h.endedAt ?? h.createdAt).toLocaleDateString()} · {h.gamesPlayed} games · {h.pointsFor} pts
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontWeight: 700 }}>{h.rank > 0 ? `#${h.rank}` : "—"}</div>
            {h.rank > 0 && <div style={{ fontSize: 11, color: "var(--muted)" }}>of {h.totalRanked}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionDetailView({ sessionId, onBack }: { sessionId: number; onBack: () => void }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.getSessionDetail>> | null>(null);

  useEffect(() => {
    setDetail(null);
    api.getSessionDetail(sessionId).then(setDetail);
  }, [sessionId]);

  if (!detail) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <button
        className="back-link"
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}
        onClick={onBack}
      >
        ← All sessions
      </button>
      <h3 style={{ fontSize: 18, marginTop: 8, marginBottom: 2 }}>{detail.session.name}</h3>
      <p className="subtitle">
        {new Date(detail.session.endedAt ?? detail.session.createdAt).toLocaleDateString()} ·{" "}
        {detail.session.status === "ended" ? "Ended" : "Active"}
      </p>

      <div className="card">
        <div className="row between" style={{ marginBottom: 6 }}>
          <span>Your record</span>
          <strong>{detail.myStats.wins}-{detail.myStats.losses}</strong>
        </div>
        <div className="row between" style={{ marginBottom: 6 }}>
          <span>Points for / against</span>
          <strong>{detail.myStats.pointsFor} / {detail.myStats.pointsAgainst}</strong>
        </div>
        <div className="row between">
          <span>Rank</span>
          <strong>{detail.myStats.rank > 0 ? `#${detail.myStats.rank} of ${detail.myStats.totalRanked}` : "Unranked"}</strong>
        </div>
      </div>

      <h3 style={{ fontSize: 15, color: "var(--muted)", marginTop: 20 }}>Final standings</h3>
      <div className="table-wrap">
        <table className="ranking">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>W-L</th>
            </tr>
          </thead>
          <tbody>
            {detail.ranking.map((p, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{p.name}</td>
                <td>{p.wins}-{p.losses}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 15, color: "var(--muted)", marginTop: 20 }}>Your matches</h3>
      <div className="stack">
        {detail.matches.map((m) => (
          <div key={m.id} className="match-card">
            <div className="court-label">
              {m.courtLabel} · {m.endedAt ? new Date(m.endedAt).toLocaleString() : ""}
            </div>
            <div className="team-row">
              <span>You{m.teammateNames.length ? ` & ${m.teammateNames.join(" & ")}` : ""}</span>
              <strong style={{ color: m.won ? "var(--good)" : "var(--bad)" }}>{m.myScore}</strong>
            </div>
            <div className="team-row">
              <span>{m.opponentNames.join(" & ")}</span>
              <strong>{m.opponentScore}</strong>
            </div>
          </div>
        ))}
        {detail.matches.length === 0 && <div className="empty-state">No completed matches in this session.</div>}
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
