import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, TIER_BADGE_IMAGE, rankScore, LEVELS, LEVEL_ICON, LEVEL_LABEL, type Level } from "../api";
import { compressImageFile } from "../imageUpload";
import { AccountAvatar } from "../accountAvatar";
import { OverallRecordCard, type OverallRecordStats } from "../overallRecord";
import { PartnerStatsPreview, type PartnerStatsData } from "../partnerStats";

type Tab = "stats" | "rank" | "ranking" | "history" | "account";
const TABS: Tab[] = ["stats", "rank", "ranking", "history", "account"];

interface MeInfo {
  username: string;
  level: Level;
  activeParticipation: { sessionId: number; sessionName: string; approved: boolean } | null;
  accountId: number;
  pictureUpdatedAt: string | null;
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
  progressPercent: number;
  nextTier: string | null;
}

export default function PlayerHome() {
  const navigate = useNavigate();
  // Which tab is open lives in the URL (?tab=ranking), not just component
  // state -- so a link to a specific tab (e.g. PlayerProfile's "← Back",
  // reached from the Ranking tab) can send someone straight back to it
  // instead of always landing on the default Stats tab. "stats" is the
  // default and intentionally left out of the URL to keep /me's usual link
  // clean.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const [tab, setTabState] = useState<Tab>(
    requestedTab && (TABS as string[]).includes(requestedTab) ? (requestedTab as Tab) : "stats",
  );

  function setTab(next: Tab) {
    setTabState(next);
    setSearchParams(next === "stats" ? {} : { tab: next }, { replace: true });
  }

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
  mmr: number;
  tier: string;
  division: "I" | "II" | "III" | null;
  provisional: boolean;
  pictureUpdatedAt: string | null;
}

// Highest to lowest -- the order the filter buttons are shown in, and how a
// ranking list naturally reads (top tier first). Mirrors rating.ts's
// mmrToTier bands.
const RANK_DIVISIONS = ["Legend", "Champion", "Ace", "Smash", "Rally", "Fledgling"];

// The first month Overall Ranking's month filter offers -- there's nothing
// meaningful to show before this, so the dropdown doesn't bother listing it.
const RANKING_MONTH_START = "2026-09";

// Every "YYYY-MM" month from RANKING_MONTH_START through the current month,
// newest first, each paired with a human label ("September 2026"). Computed
// fresh on each call (off the wall-clock "now") rather than hardcoded, so the
// list keeps growing on its own as real months pass -- no yearly upkeep.
function monthOptions(): { value: string; label: string }[] {
  const [startYear, startMonth] = RANKING_MONTH_START.split("-").map(Number);
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1; // 1-12, to match the "YYYY-MM" value format

  const options: { value: string; label: string }[] = [];
  while (year > startYear || (year === startYear && month >= startMonth)) {
    options.push({
      value: `${year}-${String(month).padStart(2, "0")}`,
      // Anchored at UTC midnight on the 1st so the label can't drift a month
      // off in a timezone behind/ahead of UTC.
      label: new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    });
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return options;
}

// Builds a CSV file right in the browser and triggers a download -- no
// server round-trip needed, since every table this is used from is already
// fully loaded on the page by the time someone clicks "Download CSV".
function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function RankingTab() {
  const [scope, setScope] = useState<string>("all");
  const [entries, setEntries] = useState<AccountRankEntry[] | null>(null);
  const [divisionFilter, setDivisionFilter] = useState<string | null>(null);
  const me = api.playerUsername();

  useEffect(() => {
    setEntries(null);
    api.getOverallRanking(scope).then(setEntries);
  }, [scope]);

  // Already sorted by rank first (server-side, see rankAccounts), so this
  // filter is a pure narrow-down -- no re-sort needed.
  const visible = divisionFilter ? entries?.filter((e) => e.tier === divisionFilter) ?? null : entries;
  // Top 3 of whatever's currently visible get the podium treatment below --
  // of the filtered tier when one's picked (so "top 3 Fledgling", say, is
  // the top 3 Fledgling players, same list the "#" column already renumbers
  // from 1 within), of the full leaderboard otherwise. The rest stay in the
  // plain table, same as ParticipantSession.tsx's session-level Ranking tab
  // splits its own top3/rest.
  const top3 = visible?.slice(0, 3) ?? [];
  const rest = visible?.slice(3) ?? [];

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className={`btn ${scope === "all" ? "primary" : ""}`} onClick={() => setScope("all")}>
          All Time
        </button>
        <select value={scope !== "all" ? scope : ""} onChange={(e) => e.target.value && setScope(e.target.value)}>
          <option value="">Pick a month…</option>
          {monthOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="row" style={{ marginBottom: 16, flexWrap: "wrap", gap: 6 }}>
        <button className={`btn small ${divisionFilter === null ? "primary" : ""}`} onClick={() => setDivisionFilter(null)}>
          All ranks
        </button>
        {RANK_DIVISIONS.map((tier) => (
          <button
            key={tier}
            className={`btn small ${divisionFilter === tier ? "primary" : ""}`}
            onClick={() => setDivisionFilter(tier)}
          >
            {tier}
          </button>
        ))}
      </div>

      {entries === null && <div className="empty-state">Loading…</div>}
      {entries && entries.length === 0 && (
        <div className="empty-state">No games played {scope === "all" ? "yet" : "in that month"}.</div>
      )}
      {entries && entries.length > 0 && visible && visible.length === 0 && (
        <div className="empty-state">No {divisionFilter} players {scope === "all" ? "yet" : "in that month"}.</div>
      )}
      {visible && visible.length > 0 && (
        <div className="row" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
          <button
            className="btn small"
            onClick={() =>
              downloadCsv(
                `smashilog-ranking-${scope}${divisionFilter ? `-${divisionFilter.toLowerCase()}` : ""}.csv`,
                ["Rank", "Player", "Tier", "Division", "Wins", "Losses", "Win %", "Point diff"],
                visible.map((e, i) => [
                  i + 1,
                  e.username,
                  e.tier,
                  e.division ?? "",
                  e.wins,
                  e.losses,
                  e.gamesPlayed ? Math.round((e.wins / e.gamesPlayed) * 100) : 0,
                  e.gamesPlayed ? ((e.pointsFor - e.pointsAgainst) / e.gamesPlayed).toFixed(1) : "0.0",
                ]),
              )
            }
          >
            ⬇ Download CSV
          </button>
        </div>
      )}
      {top3.length > 0 && <RankPodium top3={top3} me={me} />}
      {rest.length > 0 && (
        <div className="table-wrap">
          <table className="ranking">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Rank</th>
                <th>W-L</th>
                <th>Win%</th>
                <th>Diff</th>
              </tr>
            </thead>
            <tbody>
              {rest.map((e, i) => {
                const winPct = e.gamesPlayed ? Math.round((e.wins / e.gamesPlayed) * 100) : 0;
                const avgDiff = e.gamesPlayed ? (e.pointsFor - e.pointsAgainst) / e.gamesPlayed : 0;
                const isMe = e.username === me;
                const badgeSrc = TIER_BADGE_IMAGE[e.tier] ?? TIER_BADGE_IMAGE.Fledgling;
                return (
                  <tr key={e.accountId} style={isMe ? { background: "var(--panel-2)", fontWeight: 700 } : undefined}>
                    <td>{i + 4}</td>
                    <td>
                      <span className="rank-row-icon" style={{ marginRight: 5 }}>
                        <AccountAvatar username={e.username} accountId={e.accountId} pictureUpdatedAt={e.pictureUpdatedAt} size={18} />
                      </span>
                      <Link to={`/player/${e.accountId}`} style={{ color: "inherit", textDecoration: "underline" }}>
                        {e.username}
                      </Link>
                      {isMe ? " (you)" : ""}
                    </td>
                    <td>
                      <img
                        src={badgeSrc}
                        alt=""
                        style={{ width: 18, height: 18, verticalAlign: "middle", marginRight: 5 }}
                      />
                      {e.tier}
                      {e.division ? ` ${e.division}` : ""}
                      {e.provisional && (
                        <span style={{ color: "var(--muted)" }} title="Still calibrating">
                          {" "}
                          ?
                        </span>
                      )}
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

// The account-level Overall Ranking tab's own top-3 podium -- same visual
// language as ParticipantSession.tsx/HostSession.tsx's session-level Podium/
// PodiumPlace (reuses the .podium/.podium-place/.podium-crown/.podium-stand
// CSS as-is), but a separate component rather than a shared one: this tab
// works from AccountRankEntry rows (username/accountId/tier/division/mmr),
// not session Player rows (id/name/level/currentStreak), and uses
// AccountAvatar (an account id + picture timestamp) instead of RankAvatar (a
// session Player, falling back to its level icon). Tapping a name here
// navigates to that account's public profile page, since there's no
// in-session match history to drill into at this scope.
function RankPodium({ top3, me }: { top3: AccountRankEntry[]; me: string | null }) {
  const [first, second, third] = top3;
  return (
    <div className="podium" style={{ marginBottom: 16 }}>
      <RankPodiumPlace place={2} entry={second} me={me} />
      <RankPodiumPlace place={1} entry={first} me={me} />
      <RankPodiumPlace place={3} entry={third} me={me} />
    </div>
  );
}

function RankPodiumPlace({
  place,
  entry,
  me,
}: {
  place: 1 | 2 | 3;
  entry?: AccountRankEntry;
  me: string | null;
}) {
  if (!entry) return <div className="podium-place" />;
  const rankClass = place === 1 ? "gold" : place === 2 ? "silver" : "bronze";
  const winPct = entry.gamesPlayed ? Math.round((entry.wins / entry.gamesPlayed) * 100) : 0;
  const badgeSrc = TIER_BADGE_IMAGE[entry.tier] ?? TIER_BADGE_IMAGE.Fledgling;
  return (
    <div className={`podium-place ${rankClass}`}>
      {place === 1 && <div className="podium-crown">👑</div>}
      {/* AccountAvatar is already a fully self-contained circular avatar
          (its own size/background/initials-fallback via the .avatar class),
          unlike RankAvatar which has no size opinion of its own and relies
          entirely on whatever box it's placed in -- so here, sized to
          exactly fill .podium-avatar's own width/height, it covers that
          wrapper's background gradient completely rather than letting it
          peek through behind a transparent icon. The border ring and (for
          gold) the outer glow still render around it either way, since
          those paint outside the avatar's own box, so gold/silver/bronze
          stays visually distinct even without the gradient showing. */}
      <div className="podium-avatar">
        <AccountAvatar
          username={entry.username}
          accountId={entry.accountId}
          pictureUpdatedAt={entry.pictureUpdatedAt}
          size={place === 1 ? 62 : 50}
        />
      </div>
      <div className="podium-name">
        <Link className="name-link" to={`/player/${entry.accountId}`}>
          {entry.username}
        </Link>
      </div>
      <div className="podium-tier">
        <img src={badgeSrc} alt="" style={{ width: 14, height: 14, verticalAlign: "middle", marginRight: 3 }} />
        {entry.tier}
        {entry.division ? ` ${entry.division}` : ""}
        {entry.username === me ? " · you" : ""}
      </div>
      <div className="podium-record">
        {entry.wins}-{entry.losses} ·{" "}
        <strong style={{ color: winPct >= 50 ? "var(--good)" : "var(--bad)" }}>{winPct}%</strong>
      </div>
      <div className="podium-stand">{place}</div>
    </div>
  );
}

function StatsTab() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeInfo | null>(null);
  const [stats, setStats] = useState<OverallRecordStats | null>(null);
  const [partnerStats, setPartnerStats] = useState<PartnerStatsData | null>(null);
  const [sessionsList, setSessionsList] = useState<JoinableSession[] | null>(null);

  useEffect(() => {
    api.getMe().then(setMe);
    api.getOverallStats().then(setStats);
    api.getPartnerStats().then(setPartnerStats);
    api.getJoinableSessions().then(setSessionsList);
  }, []);

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

      {stats && <OverallRecordCard stats={stats} />}

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

      {partnerStats && (
        <>
          <div>
            <h3 style={{ fontSize: 15, color: "var(--muted)", marginBottom: 2 }}>Partner stats</h3>
            <div className="subtitle" style={{ margin: 0 }}>
              A summary of how you play with and against other members.
            </div>
          </div>
          <PartnerStatsPreview stats={partnerStats} />
        </>
      )}
    </div>
  );
}

interface RatingHistoryPoint {
  endedAt: string;
  tier: string;
  division: "I" | "II" | "III" | null;
  rankScore: number;
  won: boolean;
}

// rankScore tops out at Legend (see rating.ts) -- fixed so the chart's scale
// never jumps around as new points come in.
const MAX_RANK_SCORE = 15;
const TIER_GRIDLINES: { label: string; score: number }[] = [
  { label: "Legend", score: 15 },
  { label: "Champion", score: 12 },
  { label: "Ace", score: 9 },
  { label: "Smash", score: 6 },
  { label: "Rally", score: 3 },
  { label: "Fledgling", score: 0 },
];

// Hand-rolled SVG line chart -- no charting library in this project, and a
// handful of points doesn't need one. Dots are colored win/loss so a losing
// streak's dip is visible at a glance, not just the overall trend line.
function RankTrendChart({ points }: { points: RatingHistoryPoint[] }) {
  const width = 320;
  const height = 150;
  const padLeft = 56;
  const padRight = 10;
  const padTop = 10;
  const padBottom = 10;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const xFor = (i: number) =>
    padLeft + (points.length > 1 ? (i / (points.length - 1)) * plotWidth : plotWidth / 2);
  const yFor = (score: number) => padTop + (1 - score / MAX_RANK_SCORE) * plotHeight;
  const linePoints = points.map((p, i) => `${xFor(i)},${yFor(p.rankScore)}`).join(" ");

  const dateLabel = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div className="card">
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>
        Rank over time <span>(last {points.length} rated matches)</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {TIER_GRIDLINES.map(({ label, score }) => (
          <g key={label}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={yFor(score)}
              y2={yFor(score)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text x={padLeft - 6} y={yFor(score) + 3} fontSize={9} fill="var(--muted)" textAnchor="end">
              {label}
            </text>
          </g>
        ))}
        <polyline points={linePoints} fill="none" stroke="var(--accent-2)" strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={i} cx={xFor(i)} cy={yFor(p.rankScore)} r={3} fill={p.won ? "var(--good)" : "var(--bad)"} />
        ))}
      </svg>
      <div className="row between" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
        <span>{dateLabel(points[0].endedAt)}</span>
        <span>{dateLabel(points[points.length - 1].endedAt)}</span>
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
  const [history, setHistory] = useState<RatingHistoryPoint[] | null>(null);

  useEffect(() => {
    api.getRatingHistory().then(setHistory).catch(() => setHistory([]));
  }, []);

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
        {rating.nextTier ? (
          <div style={{ marginTop: 14, width: "100%", maxWidth: 220 }}>
            <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.25)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${rating.progressPercent}%`,
                  background: "var(--accent)",
                  borderRadius: 999,
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: "#d8cdbe", marginTop: 6 }}>
              {rating.progressPercent}% of the way to {rating.nextTier}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#ffd27a", marginTop: 10, fontWeight: 700 }}>🏆 Top rank reached!</div>
        )}
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

      {history && history.length >= 2 && <RankTrendChart points={history} />}

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

// Each row opens the session's own page (/session/:id) -- for an ended
// session that's the same view a guest gets: Session awards, the podium,
// the full standings, and every match (with a "My matches" filter for a
// logged-in player). Used to be a separate, plainer in-place detail view
// that only showed a bare standings table and the player's own matches.
function HistoryTab() {
  const navigate = useNavigate();
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.getMyHistory>> | null>(null);

  useEffect(() => {
    api.getMyHistory().then(setHistory);
  }, []);

  if (history === null) return <div className="empty-state">Loading…</div>;
  if (history.length === 0) return <div className="empty-state">No past sessions yet.</div>;

  return (
    <div className="stack">
      {history.map((h) => (
        <div
          key={h.sessionId}
          className="card row between"
          style={{ cursor: "pointer" }}
          onClick={() => navigate(`/session/${h.sessionId}`)}
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

function AccountTab() {
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const [level, setLevel] = useState<Level | null>(null);
  const [levelSaving, setLevelSaving] = useState(false);
  const [levelError, setLevelError] = useState("");
  const [levelSuccess, setLevelSuccess] = useState("");

  const [me, setMe] = useState<MeInfo | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pictureError, setPictureError] = useState("");

  function reloadMe() {
    return api.getMe().then((m) => {
      setMe(m);
      setLevel(m.level);
    });
  }

  useEffect(() => {
    reloadMe();
  }, []);

  async function handlePictureChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPictureError("");
    setUploading(true);
    try {
      const dataUrl = await compressImageFile(file);
      await api.updateMyPicture(dataUrl);
      await reloadMe();
    } catch (err) {
      setPictureError(err instanceof Error ? err.message : "Could not upload that picture");
    } finally {
      setUploading(false);
    }
  }

  async function removePicture() {
    setUploading(true);
    try {
      await api.updateMyPicture(null);
      await reloadMe();
    } finally {
      setUploading(false);
    }
  }

  async function saveLevel(next: Level) {
    const previous = level;
    setLevel(next);
    setLevelSaving(true);
    setLevelError("");
    setLevelSuccess("");
    try {
      await api.updateMyLevel(next);
      setLevelSuccess("Level updated.");
      setTimeout(() => setLevelSuccess(""), 3000);
    } catch (err) {
      setLevel(previous);
      setLevelError(err instanceof Error ? err.message : "Could not update level");
    } finally {
      setLevelSaving(false);
    }
  }

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

  async function deleteAccount(e: React.FormEvent) {
    e.preventDefault();
    setDeleteError("");
    if (
      // window.confirm, not the bare name -- this component already has a
      // `confirm` state variable (the "Confirm new password" field) that
      // shadows the global dialog function of the same name.
      !window.confirm(
        "Delete your account? Your login goes away for good. Your past matches and scores stay in session " +
          "history (same as a guest player's would), but you won't be able to log back in as yourself.",
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await api.deleteAccount(deletePassword);
      api.clearPlayerSession();
      navigate("/");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete account");
      setDeleting(false);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Username</div>
        <div style={{ fontWeight: 700, fontSize: 18 }}>{api.playerUsername()}</div>
      </div>

      <div className="card row" style={{ alignItems: "center" }}>
        <AccountAvatar
          username={me?.username ?? api.playerUsername() ?? "?"}
          accountId={me?.accountId ?? 0}
          pictureUpdatedAt={me?.pictureUpdatedAt ?? null}
          size={64}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={{ marginBottom: 6 }}>Profile picture</label>
          <div className="subtitle" style={{ marginTop: 2, marginBottom: 8 }}>
            Shown wherever you play -- your match, courts, queue, ranking, and your profile.
          </div>
          <div className="row" style={{ gap: 8 }}>
            <label className="btn small" style={{ cursor: "pointer" }}>
              {uploading ? "Uploading…" : "Change photo"}
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={handlePictureChange}
                disabled={uploading || !me}
              />
            </label>
            <button type="button" className="btn small" onClick={removePicture} disabled={uploading || !me}>
              Remove
            </button>
          </div>
          {pictureError && <div className="error-text" style={{ marginTop: 6 }}>{pictureError}</div>}
        </div>
      </div>

      <div className="card">
        <label>Your level</label>
        <div className="subtitle" style={{ marginTop: 2, marginBottom: 10 }}>
          Used to fill in "Requested level" automatically the next time you request to join a session --
          no more picking it each time.
        </div>
        <select
          value={level ?? "C"}
          disabled={level === null || levelSaving}
          onChange={(e) => saveLevel(e.target.value as Level)}
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {LEVEL_ICON[l]} {l} · {LEVEL_LABEL[l]}
            </option>
          ))}
        </select>
        {levelError && (
          <div className="error-text" style={{ marginTop: 8 }}>
            {levelError}
          </div>
        )}
        {levelSuccess && (
          <div style={{ color: "var(--good)", fontSize: 14, marginTop: 8 }}>{levelSuccess}</div>
        )}
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

      <div className="card">
        <label>Delete account</label>
        <div className="subtitle" style={{ marginTop: 2, marginBottom: 10 }}>
          Your login goes away for good. Past matches and scores stay in session history, same as a guest
          player's would -- they just won't be tied to a login anymore.
        </div>
        <form className="stack" onSubmit={deleteAccount}>
          <input
            type="password"
            placeholder="Enter your password to confirm"
            value={deletePassword}
            onChange={(e) => setDeletePassword(e.target.value)}
          />
          {deleteError && <div className="error-text">{deleteError}</div>}
          <button className="btn danger" type="submit" disabled={deleting || !deletePassword}>
            {deleting ? "Deleting…" : "Delete account"}
          </button>
        </form>
      </div>
    </div>
  );
}
