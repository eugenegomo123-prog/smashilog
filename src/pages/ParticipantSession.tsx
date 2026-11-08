import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api,
  LEVELS,
  LEVEL_ICON,
  LEVEL_LABEL,
  liveCourtLabel,
  playerPictureUrl,
  type Match,
  type Player,
  type Session,
  type PlayingMode,
  type Court,
} from "../api";
import { playerKey } from "./ParticipantJoin";
import { shareResultsImage } from "../shareImage";
import { RankAvatar } from "../rankAvatar";
import { PageSkeleton } from "../ui/Skeleton";
import { Icon } from "../ui/Icon";
import { BottomNav, type NavItem } from "../ui/BottomNav";
import { SessionHeader } from "../ui/SessionHeader";
import { StatTiles } from "../ui/StatTiles";
import { NextUp } from "../ui/NextUp";
import { CourtHead, OpenCourt } from "../ui/CourtParts";
import { courtSlots, eligiblePoolFor, myQueuedMatch, type MyQueuedMatch } from "../ui/live";
import { QueueMatchCard, QueueTeams, WaitingChips } from "../ui/QueueParts";
import { RankLegend, RankRow } from "../ui/RankRows";
import { HistoryItem } from "../ui/HistoryParts";

type Tab = "home" | "queue" | "ranking" | "history" | "me";

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
  const wpA = a.gamesPlayed ? a.wins / a.gamesPlayed : 0;
  const wpB = b.gamesPlayed ? b.wins / b.gamesPlayed : 0;
  if (wpB !== wpA) return wpB - wpA;
  if (b.wins !== a.wins) return b.wins - a.wins;
  if (a.losses !== b.losses) return a.losses - b.losses;
  const diffA = a.gamesPlayed ? (a.pointsFor - a.pointsAgainst) / a.gamesPlayed : 0;
  const diffB = b.gamesPlayed ? (b.pointsFor - b.pointsAgainst) / b.gamesPlayed : 0;
  if (diffB !== diffA) return diffB - diffA;
  const levelA = LEVELS.indexOf(a.level);
  const levelB = LEVELS.indexOf(b.level);
  if (levelA !== levelB) return levelA - levelB;
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

// A single 🔥 for any win streak of 3 or more -- the exact length still shows on hover.
function fireBadge(streak: number) {
  if (streak < 3) return null;
  return <span title={`${streak}-win streak`}>🔥</span>;
}

// Top 3 in the session's current competitive ranking -- same players, same
// cutoff, and the same ordering as RankingTab's own podium below (see
// rankCompare and RankingTab), just reduced to a Set of ids for quick lookup
// against a match's 4 players.
function computeTopRankedIds(players: Player[]): Set<number> {
  const ranked = players.filter((p) => p.approved && p.playingMode !== "chill").sort(rankCompare);
  return new Set(ranked.slice(0, 3).map((p) => p.id));
}

// A match is "on fire" when 2 or more of its 4 players currently have a win
// streak (same 3-game threshold as fireBadge above), and a "top match" when 2
// or more are currently in the session's top-3 ranking (computeTopRankedIds
// above). Both are purely visual, computed fresh from already-loaded data.
function matchFlags(
  team1: number[],
  team2: number[],
  playerById: (id: number) => Player | undefined,
  topRankedIds: Set<number>,
): { fireMatch: boolean; topMatch: boolean } {
  const ids = [...team1, ...team2];
  const onFire = ids.filter((id) => (playerById(id)?.currentStreak ?? 0) >= 3).length;
  const topRanked = ids.filter((id) => topRankedIds.has(id)).length;
  return { fireMatch: onFire >= 2, topMatch: topRanked >= 2 };
}

function matchCardClass(flags: { fireMatch: boolean; topMatch: boolean }): string {
  return ["match-card", flags.fireMatch && "fire-match", flags.topMatch && "top-match"].filter(Boolean).join(" ");
}

function MatchBadges({ flags }: { flags: { fireMatch: boolean; topMatch: boolean } }) {
  if (!flags.fireMatch && !flags.topMatch) return null;
  return (
    <div className="match-badges">
      {flags.fireMatch && <span className="match-badge fire">🔥 On fire</span>}
      {flags.topMatch && <span className="match-badge top">🏅 Top match</span>}
    </div>
  );
}

// The pair that pulled off the biggest blowout this session -- the winning
// team of whichever completed match has the largest |score1 - score2|. Null
// when there's no decisive (non-tied) completed match yet.
function bestPairAward(players: Player[], history: Match[]): { names: [string, string]; diff: number } | null {
  let best: { ids: number[]; diff: number } | null = null;
  for (const m of history) {
    if (m.score1 == null || m.score2 == null) continue;
    const diff = Math.abs(m.score1 - m.score2);
    if (diff <= 0) continue;
    if (!best || diff > best.diff) {
      best = { ids: m.score1 > m.score2 ? m.team1 : m.team2, diff };
    }
  }
  if (!best) return null;
  const byId = new Map(players.map((p) => [p.id, p]));
  const names = best.ids.map((id) => byId.get(id)?.name ?? "?");
  return { names: [names[0] ?? "?", names[1] ?? "?"], diff: best.diff };
}

function buildAwards(players: Player[], history: Match[]) {
  const withGames = players.filter((p) => p.gamesPlayed > 0);
  if (withGames.length === 0) return null;

  const maxGames = Math.max(...withGames.map((p) => p.gamesPlayed));
  const mostGames = withGames.filter((p) => p.gamesPlayed === maxGames);

  const bestDiff = [...withGames].sort(
    (a, b) => (b.pointsFor - b.pointsAgainst) / b.gamesPlayed - (a.pointsFor - a.pointsAgainst) / a.gamesPlayed,
  )[0];

  const longestStreaks = computeLongestStreaks(history);
  let streakValue = 0;
  for (const p of withGames) {
    streakValue = Math.max(streakValue, longestStreaks.get(p.id) ?? 0);
  }
  const streakPlayers =
    streakValue >= 2 ? withGames.filter((p) => (longestStreaks.get(p.id) ?? 0) === streakValue) : [];

  const bestPair = bestPairAward(players, history);

  return { mostGames, bestDiff, streakPlayers, streakValue, bestPair };
}

// Share-image plumbing (the actual drawing lives in src/shareImage.ts, shared
// with HostSession.tsx's identical RankingTab) -- this just formats the date
// line and hands off already-computed session data.
function resultsDateLabel(session: Session): string {
  const prefix = session.status === "ended" ? "Final results" : "Standings so far";
  const date = new Date(session.endedAt ?? session.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${prefix} · ${date}`;
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
  const [statusPopup, setStatusPopup] = useState<string | null>(null);
  const lastStatusKey = useRef<string | null>(null);

  const [myId, setMyId] = useState<number | null>(
    () => Number(localStorage.getItem(playerKey(sessionId))) || null,
  );
  // A logged-in account player's id never lands in localStorage (see
  // ParticipantJoin.tsx -- the account join flow just navigates straight
  // here), so for them myId starts out null and is only filled in once the
  // effect below resolves. The polling effect further down is set up once on
  // mount ([sessionId] only, so its 4-second setInterval keeps calling the
  // very first `load` closure for the whole session) and checkStatusChange
  // needs today's myId every time it fires, not whatever myId happened to be
  // at that one moment -- so it reads this ref instead of the plain state
  // variable, which a stale closure would otherwise freeze at its initial
  // (often still-null, for an account player) value for the rest of the
  // session.
  const myIdRef = useRef<number | null>(myId);
  useEffect(() => {
    myIdRef.current = myId;
  }, [myId]);

  useEffect(() => {
    if (!api.isPlayerLoggedIn()) return;
    api.getMyPlayerInSession(sessionId).then((p) => {
      if (p) setMyId(p.id);
    });
  }, [sessionId]);

  const isEnded = session?.status === "ended";
  const [tab, setTabState] = useState<Tab>(isEnded ? "ranking" : "home");

  // Tabs here are just local state, not routes -- there's nothing in browser
  // history for the phone/browser's own "back" action to undo, so by default
  // it falls straight through to whatever page was open before this session
  // (e.g. the account page), which reads as "back" taking you somewhere you
  // never navigated from. To fix that, the first time a tab switch leaves
  // Home we push one extra history entry; the next physical back press
  // then has something of ours to consume, and the popstate handler below
  // turns that into "switch back to Home" instead of letting the browser
  // navigate the page away. Only one extra entry is ever pushed at a time
  // (tracked by the ref below), so hopping between Queue/Ranking/History/Me
  // doesn't require more than one back press to get to Home.
  const pushedTabGuardRef = useRef(false);

  function setTab(next: Tab) {
    if (!isEnded && next !== "home" && !pushedTabGuardRef.current) {
      window.history.pushState({ smashilogTabGuard: true }, "");
      pushedTabGuardRef.current = true;
    }
    setTabState(next);
  }

  useEffect(() => {
    function onPopState() {
      setTabState((current) => {
        if (!isEnded && current !== "home") {
          pushedTabGuardRef.current = false;
          return "home";
        }
        return current;
      });
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isEnded]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [sessionId]);

  useEffect(() => {
    if (isEnded && (tab === "home" || tab === "queue" || tab === "me")) setTab("ranking");
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
    checkStatusChange(p, m.ongoing, m.queued, s.courtLabels);
  }

  // Pops up a must-acknowledge dialog exactly once per distinct status --
  // "not in queue" -> "3rd in queue" -> "2nd in queue" -> "on court" each get
  // their own popup, but polling again with no real change (still 3rd) stays
  // silent, and so does the very first load (nothing to announce yet, just a
  // starting point to compare against). Self-chosen states (resting/inactive)
  // are tracked for comparison but never popped up -- the player just set
  // that themselves, so there's nothing to tell them.
  function checkStatusChange(allPlayers: Player[], ongoing: Match[], queued: Match[], courtLabels: Court[]) {
    const myCurrentId = myIdRef.current;
    if (!myCurrentId) return;
    const player = allPlayers.find((p) => p.id === myCurrentId);
    if (!player) return;
    const status = myCurrentStatus(player, ongoing, queued, courtLabels);
    const key = statusKey(status);
    const changed = lastStatusKey.current !== null && key !== lastStatusKey.current;
    lastStatusKey.current = key;
    if (!changed || status.kind === "resting" || status.kind === "inactive") return;
    if (navigator.vibrate) navigator.vibrate([100, 60, 100]);
    setStatusPopup(describeStatus(status));
  }

  const playerById = (pid: number) => players.find((p) => p.id === pid);
  const me = myId ? players.find((p) => p.id === myId) : undefined;
  const topRankedIds = computeTopRankedIds(players);

  if (!session) return <PageSkeleton nav />;

  // A finished session only has its results to look at.
  const navItems: NavItem<Tab>[] = isEnded
    ? [
        { id: "ranking", label: "Ranking", icon: "trophy" },
        { id: "history", label: "History", icon: "history" },
      ]
    : [
        { id: "home", label: "Home", icon: "home" },
        { id: "queue", label: "Queue", icon: "list" },
        { id: "ranking", label: "Ranking", icon: "trophy" },
        { id: "history", label: "History", icon: "history" },
        { id: "me", label: "Me", icon: "user" },
      ];

  return (
    <div className="screen rail wide">
      {/* While the session is live and we're on any tab other than Home,
          this just returns to Home instead of leaving the session --
          otherwise tapping "back" from, say, History dropped you all the way
          out to the account page, which read as "back" taking you somewhere
          you didn't navigate from. Once already on Home (or the session
          has ended, so there's no Home tab to return to), it behaves as
          a normal back link again. */}
      <Link
        className="back-link"
        to={api.isPlayerLoggedIn() ? (isEnded ? "/me?tab=history" : "/me") : "/join"}
        onClick={(e) => {
          if (!isEnded && tab !== "home") {
            e.preventDefault();
            setTab("home");
          }
        }}
      >
        <Icon name="chevron-left" size={16} />
        {!isEnded && tab !== "home"
          ? "Home"
          : api.isPlayerLoggedIn()
            ? isEnded
              ? "My history"
              : "My account"
            : "All sessions"}
      </Link>
      {statusPopup && <StatusPopup message={statusPopup} onDismiss={() => setStatusPopup(null)} />}
      <SessionHeader name={session.name} status={session.status} />

      <div key={tab} className="tab-panel">
      {tab === "home" && (
        <div>
          <StatTiles
            players={players.filter((p) => p.approved).length}
            courtsInPlay={matchData.ongoing.length}
            courtCount={session.courtCount}
            waiting={eligiblePoolFor(players, matchData.ongoing, matchData.queued).length}
          />
          <div className="stack">
            {me && (
              <HomeStatus
                player={me}
                players={players}
                ongoing={matchData.ongoing}
                queued={matchData.queued}
                courtLabels={session.courtLabels}
                autoQueue={session.autoQueue}
              />
            )}
            <div className="section-head" style={{ marginBottom: 0 }}>
              <span className="section-title">Courts</span>
              <span className="caption">
                {matchData.ongoing.length} of {session.courtCount} in play
              </span>
            </div>
            <OngoingTab
              matches={matchData.ongoing}
              courtLabels={session.courtLabels}
              playerById={playerById}
              myId={myId}
              topRankedIds={topRankedIds}
            />
          </div>
          <NextUp
            queued={matchData.queued}
            playerById={playerById}
            onOpenQueue={() => setTab("queue")}
            myId={myId}
            ongoing={matchData.ongoing}
            courtLabels={session.courtLabels}
            auto={session.autoQueue}
          />
        </div>
      )}
      {tab === "me" && me && <MeTab player={me} players={players} onChanged={load} />}
      {tab === "queue" && (
        <QueueTab
          queued={matchData.queued}
          ongoing={matchData.ongoing}
          players={players}
          playerById={playerById}
          myId={myId}
          topRankedIds={topRankedIds}
        />
      )}
      {tab === "ranking" && (
        <RankingTab
          session={session}
          players={players.filter((p) => p.approved && p.playingMode !== "chill")}
          history={matchData.history}
          playerById={playerById}
          myId={myId}
        />
      )}
      {tab === "history" && <HistoryTab history={matchData.history} playerById={playerById} myId={myId} />}
      </div>

      <BottomNav items={navItems} active={tab} onChange={setTab} />
    </div>
  );
}

// A round profile picture, falling back to initials-on-a-circle when the
// player has no photo (or it fails to load) -- the dedicated picture route
// 404s in that case, which this treats as just another load failure.
function Avatar({ player, size = 48 }: { player: Player | undefined; size?: number }) {
  const [failed, setFailed] = useState(false);
  const name = player?.name ?? "?";
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "?";
  const style = { width: size, height: size, fontSize: Math.round(size * 0.36) };
  // Only a registered account can have a picture (see db/schema.ts's
  // accounts.profilePicture) -- a guest player's accountId is always null, so
  // there's no point even trying to load one for them.
  if (!player || !player.accountId || failed) {
    return (
      <div className="avatar" style={style}>
        {initials}
      </div>
    );
  }
  return (
    <img
      className="avatar"
      style={style}
      src={playerPictureUrl(player)}
      alt={name}
      onError={() => setFailed(true)}
    />
  );
}

function TeamColumn({
  ids,
  playerById,
  size,
}: {
  ids: number[];
  playerById: (id: number) => Player | undefined;
  size: number;
}) {
  return (
    <div className="matchup-team">
      {ids.map((id) => {
        const p = playerById(id);
        return (
          <div className="matchup-player" key={id}>
            <Avatar player={p} size={size} />
            <span className="matchup-name">{p?.name ?? "?"}</span>
          </div>
        );
      })}
    </div>
  );
}

// The "2 circles stacked, VS in the middle, 2 more circles stacked, names
// under each picture" matchup display -- shared by the Home tab's "your
// match right now" card and the Courts tab's list of every match in play.
function Matchup({
  team1,
  team2,
  playerById,
  size = 48,
}: {
  team1: number[];
  team2: number[];
  playerById: (id: number) => Player | undefined;
  size?: number;
}) {
  return (
    <div className="matchup">
      <TeamColumn ids={team1} playerById={playerById} size={size} />
      <div className="matchup-vs">VS</div>
      <TeamColumn ids={team2} playerById={playerById} size={size} />
    </div>
  );
}

type MyStatus =
  | { kind: "pending" }
  | { kind: "onCourt"; courtLabel: string; match: Match }
  | { kind: "queued"; position: number; total: number }
  | { kind: "resting" }
  | { kind: "inactive" }
  | { kind: "unassigned" };

// Where this player stands right now, checked in priority order: pending
// approval outranks everything else (nothing matters until the host lets
// them in), then actually being on a court, then queued for one, then their
// own resting/inactive choice, and only then "active, but not picked yet."
function myCurrentStatus(player: Player, ongoing: Match[], queued: Match[], courtLabels: Court[]): MyStatus {
  if (!player.approved) return { kind: "pending" };

  const myMatch = ongoing.find((m) => [...m.team1, ...m.team2].includes(player.id));
  if (myMatch) {
    return { kind: "onCourt", courtLabel: liveCourtLabel(courtLabels, myMatch), match: myMatch };
  }

  const queueIndex = queued.findIndex((m) => [...m.team1, ...m.team2].includes(player.id));
  if (queueIndex !== -1) return { kind: "queued", position: queueIndex + 1, total: queued.length };

  if (player.status === "resting") return { kind: "resting" };
  if (player.status === "inactive") return { kind: "inactive" };
  return { kind: "unassigned" };
}

// A stable fingerprint of a MyStatus, so the popup below can tell "still 3rd
// in the queue" (same key, stay quiet) apart from "now 2nd" or "now on court"
// (new key, something to announce). Position is folded into the queued key
// since that's the part of "queued" that actually changes from poll to poll.
function statusKey(status: MyStatus): string {
  if (status.kind === "queued") return `queued:${status.position}`;
  if (status.kind === "onCourt") return `onCourt:${status.courtLabel}`;
  return status.kind;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// A one-sentence, plain-language readout of a MyStatus change, for the
// must-acknowledge popup below -- resting/inactive are deliberately not
// described here since those are changes the player just made themselves (see
// the popup's own kind check before calling this).
function describeStatus(status: MyStatus): string {
  switch (status.kind) {
    case "pending":
      return "You're in! Your join request is just waiting on the host's approval before you can be matched.";
    case "onCourt":
      return `You're up — head to ${status.courtLabel} now.`;
    case "queued":
      if (status.position === 1) return "You're next in the queue — get ready, your court is coming up!";
      return `You're ${ordinal(status.position)} in the queue, with ${status.position - 1} match${
        status.position - 1 === 1 ? "" : "es"
      } ahead of you.`;
    case "unassigned":
      return "You're active and available — the host hasn't sent you to a court yet.";
    default:
      return "";
  }
}

// Blocks until acknowledged -- unlike a toast, a status change (especially a
// court assignment) shouldn't be something the player can miss by glancing
// away for a few seconds.
function StatusPopup({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <p>{message}</p>
        <button className="btn primary" style={{ width: "100%" }} onClick={onDismiss}>
          OK
        </button>
      </div>
    </div>
  );
}

// Visual language: green = go now, amber = the system's working on it (queued,
// pending, or just not picked yet), gray = sitting out by your own choice.
function statusColors(status: MyStatus): { bg: string; fg: string } {
  switch (status.kind) {
    case "onCourt":
      return { bg: "var(--good-bg)", fg: "var(--good)" };
    case "resting":
    case "inactive":
      return { bg: "var(--inactive-bg)", fg: "var(--inactive)" };
    case "pending":
      return { bg: "rgba(255, 138, 61, 0.16)", fg: "#ffa45c" };
    case "queued":
    case "unassigned":
      return { bg: "var(--resting-bg)", fg: "var(--resting)" };
  }
}

// A queued match from the player's own side: "You & Mia vs Joe & Ana".
function myMatchLine(info: MyQueuedMatch, nameOf: (id: number) => string): string {
  const mine = ["You", ...(info.partner != null ? [nameOf(info.partner)] : [])].join(" & ");
  return `${mine} vs ${info.opponents.map(nameOf).join(" & ")}`;
}

// `next` is the player's next queued match, passed only when it's worth showing
// (see HomeStatus): then "on court" gets a "Next match" block under it and
// "queued" gets who they'll play with and against.
function StatusCardBody({
  status,
  next,
  nameOf,
}: {
  status: MyStatus;
  next?: MyQueuedMatch | null;
  nameOf?: (id: number) => string;
}) {
  const nextLine = next && nameOf ? myMatchLine(next, nameOf) : "";
  switch (status.kind) {
    case "onCourt":
      return (
        // (With a next match underneath, the block takes the whole row so the
        // divider line runs right up to the level icon.)
        <div style={next && nextLine ? { flex: 1 } : undefined}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.03 }}>🏸 ON COURT NOW</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 2 }}>Head to {status.courtLabel}</div>
          {next && nextLine && (
            <div className="status-next">
              <div className="status-next-label">
                Next match · {next.position === 1 ? "first in line" : `#${next.position} in line`}
              </div>
              <div className="status-next-teams">{nextLine}</div>
            </div>
          )}
        </div>
      );
    case "queued":
      return (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.03 }}>⏳ QUEUED</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 2 }}>#{status.position} in line</div>
          <div style={{ fontSize: 13, color: "var(--text)", marginTop: 4 }}>
            {status.position === 1
              ? "You're next — get ready!"
              : `${status.position - 1} match${status.position - 1 === 1 ? "" : "es"} ahead of you`}
          </div>
          {nextLine && (
            <div className="status-next-teams" style={{ marginTop: 6 }}>
              {nextLine}
            </div>
          )}
        </div>
      );
    case "pending":
      return (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.03 }}>⏳ PENDING APPROVAL</div>
          <div className="card-headline-sm">Waiting for the host to approve you</div>
        </div>
      );
    case "resting":
    case "inactive": {
      const label = status.kind === "resting" ? "Resting" : "Inactive";
      return (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.03 }}>💤 {label.toUpperCase()}</div>
          <div className="card-headline-sm">
            Set to {label.toLowerCase()} — switch to Active below to join the rotation
          </div>
        </div>
      );
    }
    case "unassigned":
      return (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.03 }}>⏳ NOT ASSIGNED YET</div>
          <div className="card-headline-sm">The host hasn't sent you to a court yet</div>
        </div>
      );
  }
}

// The top of the Home tab: where this player stands right now (on a court,
// Nth in the queue, resting...) and, once they're on a court, their match.
function HomeStatus({
  player,
  players,
  ongoing,
  queued,
  courtLabels,
  autoQueue,
}: {
  player: Player;
  players: Player[];
  ongoing: Match[];
  queued: Match[];
  courtLabels: Court[];
  autoQueue: boolean;
}) {
  const status = myCurrentStatus(player, ongoing, queued, courtLabels);
  const { bg, fg } = statusColors(status);

  // The look-ahead: the player's next queued match. While they're still on court
  // it's shown whenever they have one (that's the projection -- only Auto queue
  // plans a match for someone who's still playing); a player who's already
  // waiting in line sees it only when Auto queue is on, so the card is exactly
  // as it always was for the host's own queue.
  const next =
    status.kind === "onCourt" || (status.kind === "queued" && autoQueue)
      ? myQueuedMatch(player.id, queued)
      : null;
  const nameOf = (id: number) => players.find((p) => p.id === id)?.name ?? "?";

  // (A separate "Your match" card used to sit under this one. It repeated the
  // same four names that the Courts list directly below already shows, with
  // the player's own court highlighted in green, so it was removed.)
  return (
    <div className="card row between" style={{ background: bg, color: fg, alignItems: "center" }}>
      <StatusCardBody status={status} next={next} nameOf={nameOf} />
      <div className="level-pill" style={{ width: 44, height: 44, fontSize: 22 }} title={LEVEL_LABEL[player.level]}>{LEVEL_ICON[player.level]}</div>
    </div>
  );
}

// The Me tab: who I'm signed in as, and my own settings for this session
// (level read-only, status, preferred partner, playing mode).
function MeTab({
  player,
  players,
  onChanged,
}: {
  player: Player;
  players: Player[];
  onChanged: () => void;
}) {
  const others = players
    .filter((p) => p.approved && p.id !== player.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="stack">
      <div className="card">
        <div className="caption">Signed in as</div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{player.name}</div>
      </div>
      <div className="card">
        <label>My level</label>
        {/* Read-only once joined -- set from what was requested at join time
            (see the Approve button in HostSession.tsx's PlayersTab) and from
            then on only the host can change it (its roster's own level
            select), not the player themselves. */}
        <div className="row" style={{ alignItems: "center", gap: 8, marginTop: 4 }}>
          <div className="level-pill">{LEVEL_ICON[player.level]}</div>
          <span>{LEVEL_LABEL[player.level]}</span>
        </div>
        <div className="subtitle" style={{ marginTop: 6, marginBottom: 0 }}>
          Set to what you requested when you joined. Only the host can change it once the session is underway.
        </div>
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
      <div className="card">
        <label>Playing mode</label>
        <select
          value={player.playingMode}
          onChange={async (e) => {
            await api.updatePlayer(player.id, { playingMode: e.target.value as PlayingMode });
            onChanged();
          }}
        >
          <option value="competitive">🏆 I'm competitive — put me in the ranking</option>
          <option value="chill">😎 I'm chilling (unranked)</option>
        </select>
      </div>
    </div>
  );
}

function OngoingTab({
  matches,
  courtLabels,
  playerById,
  myId,
  topRankedIds,
}: {
  matches: Match[];
  courtLabels: Court[];
  playerById: (id: number) => Player | undefined;
  myId: number | null;
  topRankedIds: Set<number>;
}) {
  // One card per court, in court order: the match on it, or an "open" card.
  const { slots, extra } = courtSlots(courtLabels, matches);

  function matchCard(m: Match) {
    const mine = [...m.team1, ...m.team2].includes(myId ?? -1);
    const flags = matchFlags(m.team1, m.team2, playerById, topRankedIds);
    return (
      <div key={m.id} className={`${matchCardClass(flags)}${mine ? " mine" : ""}`}>
        <CourtHead label={liveCourtLabel(courtLabels, m)} startedAt={m.startedAt} />
        <MatchBadges flags={flags} />
        <Matchup team1={m.team1} team2={m.team2} playerById={playerById} size={40} />
      </div>
    );
  }

  return (
    <div className="stack cols">
      {slots.map(({ court, match }) => (match ? matchCard(match) : <OpenCourt key={court.id} label={court.label} />))}
      {extra.map(matchCard)}
      {slots.length === 0 && extra.length === 0 && <div className="empty-state">No games in progress.</div>}
    </div>
  );
}

function QueueTab({
  queued,
  ongoing,
  players,
  playerById,
  myId,
  topRankedIds,
}: {
  queued: Match[];
  ongoing: Match[];
  players: Player[];
  playerById: (id: number) => Player | undefined;
  myId: number | null;
  topRankedIds: Set<number>;
}) {
  // Players who are ready but not in any match yet -- the same "Waiting" rule
  // as the number on the Home tab.
  const waiting = eligiblePoolFor(players, ongoing, queued);

  return (
    <div>
      <div className="section-head">
        <span className="section-title">Queue</span>
        <span className="caption">
          {queued.length} {queued.length === 1 ? "match" : "matches"}
        </span>
      </div>
      <div className="stack cols">
        {queued.map((m, i) => {
          const mine = [...m.team1, ...m.team2].includes(myId ?? -1);
          const flags = matchFlags(m.team1, m.team2, playerById, topRankedIds);
          return (
            <QueueMatchCard
              key={m.id}
              n={i + 1}
              hero={i === 0}
              className={matchCardClass(flags)}
              mine={mine}
              head={mine ? <span className="you-chip">You</span> : undefined}
            >
              <MatchBadges flags={flags} />
              {i === 0 ? (
                <Matchup team1={m.team1} team2={m.team2} playerById={playerById} size={48} />
              ) : (
                <QueueTeams team1={m.team1} team2={m.team2} playerById={playerById} myId={myId} />
              )}
            </QueueMatchCard>
          );
        })}
        {queued.length === 0 && <div className="empty-state">No matches queued right now.</div>}
      </div>

      <div className="section-head" style={{ marginTop: 28 }}>
        <span className="section-title">Waiting players</span>
        <span className="caption">{waiting.length}</span>
      </div>
      <WaitingChips players={waiting} myId={myId} />
    </div>
  );
}

function RankingTab({
  session,
  players,
  history,
  playerById,
  myId,
}: {
  session: Session;
  players: Player[];
  history: Match[];
  playerById: (id: number) => Player | undefined;
  myId: number | null;
}) {
  const sorted = [...players].sort(rankCompare);
  // This player's place in the ranking, if they're in it (chill players and
  // anyone not yet approved aren't ranked).
  const myPlace = myId != null ? sorted.findIndex((p) => p.id === myId) + 1 : 0;
  const top3 = sorted.slice(0, 3);
  const rest = sorted.slice(3);
  const awards = session.status === "ended" ? buildAwards(players, history) : null;
  const [shareMsg, setShareMsg] = useState("");
  const [sharing, setSharing] = useState(false);
  // Which player's name was tapped, if any -- set, this tab shows that
  // player's matches for *this* session instead of the ranking, with a
  // "Back" that just clears it (a drill-down in place, no route change).
  const [viewingPlayer, setViewingPlayer] = useState<Player | null>(null);

  async function handleShare() {
    setSharing(true);
    try {
      await shareResultsImage(
        { sessionName: session.name, dateLabel: resultsDateLabel(session), sorted, awards },
        (msg) => {
          setShareMsg(msg);
          setTimeout(() => setShareMsg(""), 4000);
        },
      );
    } finally {
      setSharing(false);
    }
  }

  if (viewingPlayer) {
    return (
      <PlayerMatchHistory
        player={viewingPlayer}
        history={history}
        playerById={playerById}
        onBack={() => setViewingPlayer(null)}
      />
    );
  }

  return (
    <div>
      <div className="row between" style={{ marginBottom: 16 }}>
        <div className="caption">{shareMsg || (myPlace > 0 ? `You're #${myPlace} of ${sorted.length}` : " ")}</div>
        <button className="btn small with-icon" onClick={handleShare} disabled={sorted.length === 0 || sharing}>
          <Icon name="share" size={16} />
          {sharing ? "Preparing image…" : "Share results"}
        </button>
      </div>

      {awards && <AwardsPanel awards={awards} />}

      {top3.length > 0 && <Podium top3={top3} onSelect={setViewingPlayer} myId={myId} />}
      {rest.length > 0 && (
        <>
          <RankLegend />
          <div className="rank-list">
            {rest.map((p, i) => {
              const avgDiff = p.gamesPlayed ? (p.pointsFor - p.pointsAgainst) / p.gamesPlayed : 0;
              return (
                <RankRow
                  key={p.id}
                  rank={i + 4}
                  avatar={<RankAvatar player={p} />}
                  name={p.name}
                  nameExtra={fireBadge(p.currentStreak)}
                  sub={
                    <span>
                      {p.wins}W · {p.losses}L
                    </span>
                  }
                  winPct={p.gamesPlayed ? Math.round((p.wins / p.gamesPlayed) * 100) : 0}
                  avgDiff={avgDiff}
                  isMe={p.id === myId}
                  onClick={() => setViewingPlayer(p)}
                />
              );
            })}
          </div>
        </>
      )}
      {sorted.length === 0 && <div className="empty-state">No ranked players yet.</div>}
    </div>
  );
}

// Each award is its own tile (name prominent, the label and the stat it was
// won with as small captions above/below) in a 2-column grid -- same tile
// idea as OverallRecordCard's 2x2 grid, rather than a plain settings-style
// list of label/value rows, which read flatter than an "awards" section
// probably should.
function AwardsPanel({ awards }: { awards: NonNullable<ReturnType<typeof buildAwards>> }) {
  const diffVal = (awards.bestDiff.pointsFor - awards.bestDiff.pointsAgainst) / awards.bestDiff.gamesPlayed;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 15, color: "var(--accent-dark)", marginTop: 0 }}>🏆 Session awards</h3>
      <div className="awards-grid">
        <div className="award-tile">
          <div className="award-tile-label">📈 Best point diff</div>
          <div className="award-tile-winner">{awards.bestDiff.name}</div>
          <div className="award-tile-value">
            {diffVal > 0 ? "+" : ""}
            {diffVal.toFixed(1)} diff
          </div>
        </div>
        <div className="award-tile">
          <div className="award-tile-label">🎽 Most games played</div>
          <div className="award-tile-winner">{awards.mostGames.map((p) => p.name).join(", ")}</div>
          <div className="award-tile-value">
            {awards.mostGames[0].gamesPlayed} game{awards.mostGames[0].gamesPlayed === 1 ? "" : "s"}
          </div>
        </div>
        {awards.streakPlayers.length > 0 && (
          <div className="award-tile">
            <div className="award-tile-label">🔥 Longest win streak</div>
            <div className="award-tile-winner">{awards.streakPlayers.map((p) => p.name).join(", ")}</div>
            <div className="award-tile-value">
              {awards.streakValue} win{awards.streakValue === 1 ? "" : "s"}
            </div>
          </div>
        )}
        {awards.bestPair && (
          <div className="award-tile">
            <div className="award-tile-label">🤝 Best pair</div>
            <div className="award-tile-winner">{awards.bestPair.names.join(" & ")}</div>
            <div className="award-tile-value">+{awards.bestPair.diff} diff</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Podium({
  top3,
  onSelect,
  myId,
}: {
  top3: Player[];
  onSelect: (player: Player) => void;
  myId: number | null;
}) {
  const [first, second, third] = top3;
  return (
    <div className="podium">
      <PodiumPlace place={2} player={second} onSelect={onSelect} myId={myId} />
      <PodiumPlace place={1} player={first} onSelect={onSelect} myId={myId} />
      <PodiumPlace place={3} player={third} onSelect={onSelect} myId={myId} />
    </div>
  );
}

function PodiumPlace({
  place,
  player,
  onSelect,
  myId,
}: {
  place: 1 | 2 | 3;
  player?: Player;
  onSelect: (player: Player) => void;
  myId: number | null;
}) {
  if (!player) return <div className="podium-place" />;
  const rankClass = place === 1 ? "gold" : place === 2 ? "silver" : "bronze";
  const winPct = player.gamesPlayed ? Math.round((player.wins / player.gamesPlayed) * 100) : 0;
  const isMe = player.id === myId;
  return (
    <div className={`podium-place ${rankClass}${isMe ? " me" : ""}`}>
      {place === 1 && <div className="podium-crown">👑</div>}
      <div className="podium-avatar"><RankAvatar player={player} /></div>
      <div className="podium-name">
        <button type="button" className="name-link" onClick={() => onSelect(player)}>
          {player.name}
        </button>{" "}
        {fireBadge(player.currentStreak)}
      </div>
      {isMe && <span className="you-chip sm">You</span>}
      <div className="podium-record">
        {player.wins}-{player.losses} ·{" "}
        <strong style={{ color: winPct >= 50 ? "var(--good)" : "var(--bad)" }}>{winPct}%</strong>
      </div>
      <div className="podium-stand">{place}</div>
    </div>
  );
}

// Shown in place of the ranking (RankingTab's "viewingPlayer") when a name on
// the podium or table is tapped -- that player's matches from *this* session
// only. Cross-session history lives on their account profile, a separate
// page reached a different way (PlayerProfile.tsx, via the cross-session
// Ranking tab on PlayerHome.tsx) -- this one never navigates, it just swaps
// what RankingTab renders, same as HistoryTab's own "only my matches" filter
// swaps what's in its list.
function PlayerMatchHistory({
  player,
  history,
  playerById,
  onBack,
}: {
  player: Player;
  history: Match[];
  playerById: (id: number) => Player | undefined;
  onBack: () => void;
}) {
  const matches = history.filter((m) => [...m.team1, ...m.team2].includes(player.id));

  return (
    <div>
      <button type="button" className="back-link" onClick={onBack}>
        <Icon name="chevron-left" size={16} />
        Back to ranking
      </button>

      <div className="card row" style={{ gap: 10, marginBottom: 16 }}>
        <div style={{ width: 40, height: 40, borderRadius: "50%", overflow: "hidden", display: "flex", flexShrink: 0 }}>
          <RankAvatar player={player} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{player.name}</div>
          <div className="caption">
            {player.wins}-{player.losses} this session
          </div>
        </div>
      </div>

      <div className="stack cols">
        {matches.map((m) => (
          <HistoryItem key={m.id} match={m} playerById={playerById} focusId={player.id} />
        ))}
        {matches.length === 0 && <div className="empty-state">No completed matches yet.</div>}
      </div>
    </div>
  );
}

function HistoryTab({
  history,
  playerById,
  myId,
}: {
  history: Match[];
  playerById: (id: number) => Player | undefined;
  myId: number | null;
}) {
  const [onlyMine, setOnlyMine] = useState(false);
  const filtered = onlyMine && myId ? history.filter((m) => [...m.team1, ...m.team2].includes(myId)) : history;

  return (
    <div>
      {/* Same pill-button filter pattern as the Ranking tabs' division filter
          (PlayerHome.tsx/HostSession.tsx) rather than a bare checkbox, so it
          actually reads as a filter at a glance. */}
      {myId && (
        <div className="row" style={{ marginBottom: 12, flexWrap: "wrap", gap: 6 }}>
          <button className={`btn small ${!onlyMine ? "primary" : ""}`} onClick={() => setOnlyMine(false)}>
            All matches
          </button>
          <button className={`btn small ${onlyMine ? "primary" : ""}`} onClick={() => setOnlyMine(true)}>
            My matches
          </button>
        </div>
      )}
      <div className="stack cols">
        {filtered.map((m) => (
          <HistoryItem key={m.id} match={m} playerById={playerById} focusId={myId} />
        ))}
        {history.length === 0 && <div className="empty-state">No completed matches yet.</div>}
        {history.length > 0 && filtered.length === 0 && (
          <div className="empty-state">No matches yet where you played.</div>
        )}
      </div>
    </div>
  );
}
