export type Level = "A" | "B" | "C" | "D" | "E";
export type PlayerStatus = "active" | "resting" | "inactive";
export type PlayingMode = "competitive" | "chill";

// A physical court. id is stable and server-generated -- it never changes
// when the court is renamed, so an ongoing match stays linked to the right
// court across a rename (see worker/lib/courts.ts on the server).
export interface Court {
  id: string;
  label: string;
}

export interface Session {
  id: number;
  name: string;
  status: "active" | "ended";
  courtCount: number;
  courtLabels: Court[];
  createdAt: string;
  endedAt: string | null;
}

export interface Player {
  id: number;
  sessionId: number;
  name: string;
  level: Level;
  requestedLevel: Level | null;
  status: PlayerStatus;
  playingMode: PlayingMode;
  approved: boolean;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  currentStreak: number;
  gamesPlayed: number;
  lastMatchEndedAt: string | null;
  preferredPartnerId: number | null;
  // Null for a guest (today's default join flow); set when this player row
  // belongs to a registered account (see db/schema.ts). Used client-side only
  // to decide whether a "reset password" action makes sense for this player.
  accountId: number | null;
  createdAt: string;
}

export interface Match {
  id: number;
  sessionId: number;
  // Display-name snapshot of the court as of when this match went ongoing --
  // frozen from then on, so it's exactly right for history but can go stale
  // for a still-ongoing match if the court gets renamed afterward. Use
  // liveCourtLabel() below (with the session's current courtLabels) rather
  // than this field directly wherever an ongoing match's court name is shown.
  courtLabel: string;
  // Stable court identity (matches the Court this match is actually on),
  // independent of the label above. Null while suggested/queued (no court
  // yet), and for any match that was already ongoing before this field
  // existed -- see liveCourtLabel()'s fallback below.
  courtId: string | null;
  team1: number[];
  team2: number[];
  status: "ongoing" | "completed" | "suggested" | "queued";
  score1: number | null;
  score2: number | null;
  startedAt: string;
  endedAt: string | null;
  queuePosition: number | null;
}

// The court name to actually display for a match: resolves via the session's
// current court list by stable id, falling back to the match's own frozen
// courtLabel snapshot only if no court with that id exists anymore (the
// court was removed by shrinking court count) or for the rare pre-courtId
// match (courtId null). This is what keeps a renamed court's live matches
// showing the new name instead of the name it had when the match started.
export function liveCourtLabel(courtLabels: Court[], match: Pick<Match, "courtId" | "courtLabel">): string {
  if (match.courtId != null) {
    const court = courtLabels.find((c) => c.id === match.courtId);
    if (court) return court.label;
  }
  return match.courtLabel;
}

function hostToken(): string | null {
  return localStorage.getItem("smashilog_host_token");
}

function playerToken(): string | null {
  return localStorage.getItem("smashilog_player_token");
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "application/json");
  const token = hostToken();
  if (token) headers.set("x-host-token", token);
  const pToken = playerToken();
  if (pToken) headers.set("x-player-token", pToken);
  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  hostLogin: (password: string) =>
    request<{ token: string }>("/host-auth", { method: "POST", body: JSON.stringify({ password }) }),
  setHostToken: (token: string) => localStorage.setItem("smashilog_host_token", token),
  clearHostToken: () => localStorage.removeItem("smashilog_host_token"),
  isHost: () => !!hostToken(),

  register: (username: string, password: string, token: string) =>
    request<{ token: string; username: string }>("/register", {
      method: "POST",
      body: JSON.stringify({ username, password, token }),
    }),
  login: (username: string, password: string) =>
    request<{ token: string; username: string }>("/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  setPlayerSession: (token: string, username: string) => {
    localStorage.setItem("smashilog_player_token", token);
    localStorage.setItem("smashilog_player_username", username);
  },
  clearPlayerSession: () => {
    localStorage.removeItem("smashilog_player_token");
    localStorage.removeItem("smashilog_player_username");
  },
  isPlayerLoggedIn: () => !!playerToken(),
  playerUsername: () => localStorage.getItem("smashilog_player_username"),
  createRegistrationQr: () =>
    request<{ token: string; expiresAt: number }>("/host/registration-token", { method: "POST" }),
  getMe: () =>
    request<{
      username: string;
      level: Level;
      activeParticipation: { sessionId: number; sessionName: string; approved: boolean } | null;
    }>("/me"),
  // Sets the account's own level -- used to auto-fill "requested level" the
  // next time this account requests to join a session (no more per-join prompt).
  updateMyLevel: (level: Level) =>
    request<{ level: Level }>("/me/level", { method: "PATCH", body: JSON.stringify({ level }) }),
  getOverallStats: () =>
    request<{
      sessionsPlayed: number;
      gamesPlayed: number;
      wins: number;
      losses: number;
      pointsFor: number;
      pointsAgainst: number;
      averagePointDiff: number;
      highestWinStreak: number;
    }>("/me/stats"),
  getMyRating: () =>
    request<{
      tier: string;
      division: "I" | "II" | "III" | null;
      provisional: boolean;
      seasonPoints: number;
      ratedGamesPlayed: number;
      currentRatingStreak: number;
      provisionalGamesThreshold: number;
      // 0-100, toward nextTier -- never the raw mmr itself. nextTier is null
      // once there's nowhere left to climb (already Legend).
      progressPercent: number;
      nextTier: string | null;
    }>("/me/rating"),
  // This account's tier/rank at each rated match, oldest first -- for the
  // Rank tab's trend chart. Never raw mmr, same "tier, not a number" rule as
  // getMyRating above.
  getRatingHistory: () =>
    request<{
      points: {
        endedAt: string;
        tier: string;
        division: "I" | "II" | "III" | null;
        rankScore: number;
        won: boolean;
      }[];
    }>("/me/rating-history").then((r) => r.points),
  getJoinableSessions: () =>
    request<{ id: number; name: string; playerCount: number; alreadyJoined: boolean; approved: boolean }[]>(
      "/me/joinable-sessions",
    ),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/me/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  // Removes the login (requires the current password); past matches and
  // other players' stats are unaffected -- see worker/index.ts's
  // /me/delete-account for exactly what happens to this account's own data.
  deleteAccount: (password: string) =>
    request<{ ok: true }>("/me/delete-account", { method: "POST", body: JSON.stringify({ password }) }),
  getMyHistory: () =>
    request<
      {
        sessionId: number;
        sessionName: string;
        endedAt: string | null;
        createdAt: string;
        gamesPlayed: number;
        pointsFor: number;
        wins: number;
        losses: number;
        rank: number;
        totalRanked: number;
      }[]
    >("/me/history"),
  getSessionDetail: (sessionId: number) =>
    request<{
      session: { id: number; name: string; status: string; endedAt: string | null; createdAt: string };
      myStats: {
        gamesPlayed: number;
        wins: number;
        losses: number;
        pointsFor: number;
        pointsAgainst: number;
        rank: number;
        totalRanked: number;
        level: string;
      };
      ranking: { name: string; level: string; wins: number; losses: number; gamesPlayed: number }[];
      matches: {
        id: number;
        courtLabel: string;
        teammateNames: string[];
        opponentNames: string[];
        myScore: number;
        opponentScore: number;
        won: boolean;
        endedAt: string | null;
      }[];
    }>(`/me/history/${sessionId}`),
  getOverallRanking: (scope: string) =>
    request<{
      scope: string;
      entries: {
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
      }[];
    }>(`/me/ranking?scope=${encodeURIComponent(scope)}`).then((r) => r.entries),
  getMyPlayerInSession: (sessionId: number) =>
    request<{ player: Player | null }>(`/sessions/${sessionId}/my-player`).then((r) => r.player),
  // Any logged-in player can look up another account's public profile --
  // same numbers already visible on the Ranking tab, just focused on one
  // person. Used by the "view profile" link on each ranking row.
  getAccountProfile: (accountId: number) =>
    request<{
      username: string;
      stats: {
        sessionsPlayed: number;
        gamesPlayed: number;
        wins: number;
        losses: number;
        pointsFor: number;
        pointsAgainst: number;
        averagePointDiff: number;
        highestWinStreak: number;
      };
      rating: {
        tier: string;
        division: "I" | "II" | "III" | null;
        provisional: boolean;
        seasonPoints: number;
        ratedGamesPlayed: number;
        currentRatingStreak: number;
        provisionalGamesThreshold: number;
      };
    }>(`/accounts/${accountId}/profile`),
  // No level to pass here anymore -- the server fills "requested level" in
  // from the account's own level setting (see updateMyLevel above).
  requestToJoinAsAccount: (sessionId: number) =>
    request<Player>(`/sessions/${sessionId}/players`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  listSessions: () => request<Session[]>("/sessions"),
  createSession: (name: string, courtCount: number) =>
    request<Session>("/sessions", { method: "POST", body: JSON.stringify({ name, courtCount }) }),
  getSession: (id: number) => request<Session>(`/sessions/${id}`),
  updateSession: (id: number, updates: Partial<Pick<Session, "status" | "name" | "courtCount">>) =>
    request<Session>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(updates) }),
  // Renames one court by its stable id -- the id, and therefore any ongoing
  // match's link to this court, never changes. See worker/lib/courts.ts.
  renameCourt: (sessionId: number, courtId: string, label: string) =>
    request<Session>(`/sessions/${sessionId}/courts/${courtId}`, {
      method: "PATCH",
      body: JSON.stringify({ label }),
    }),
  deleteSession: (id: number) => request<{ ok: true }>(`/sessions/${id}`, { method: "DELETE" }),

  listPlayers: (sessionId: number) => request<Player[]>(`/sessions/${sessionId}/players`),
  joinSession: (sessionId: number, name: string, requestedLevel: Level) =>
    request<Player>(`/sessions/${sessionId}/players`, {
      method: "POST",
      body: JSON.stringify({ name, requestedLevel }),
    }),
  addPlayer: (sessionId: number, name: string, level: Level) =>
    request<Player>(`/sessions/${sessionId}/players`, {
      method: "POST",
      body: JSON.stringify({ name, requestedLevel: level }),
    }),
  updatePlayer: (
    id: number,
    updates: Partial<Pick<Player, "level" | "status" | "approved" | "name" | "preferredPartnerId" | "playingMode">>,
  ) => request<Player>(`/players/${id}`, { method: "PATCH", body: JSON.stringify(updates) }),
  removePlayer: (id: number) => request<{ ok: true }>(`/players/${id}`, { method: "DELETE" }),
  // Host-only: set a brand-new password for a registered player's account.
  // No old password needed/seen -- see worker/index.ts's reset-password route.
  resetPlayerPassword: (id: number, newPassword: string) =>
    request<{ ok: true }>(`/players/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    }),

  getMatches: (sessionId: number) =>
    request<{ ongoing: Match[]; history: Match[]; suggested: Match[]; queued: Match[] }>(
      `/sessions/${sessionId}/matches`,
    ),
  regenerateSuggestions: (sessionId: number) =>
    request<{ ok: true }>(`/sessions/${sessionId}/regenerate`, { method: "POST" }),
  // Moves a suggested match into the actual queue (no court chosen here -- the
  // queue fills open courts automatically, front first).
  assignMatch: (sessionId: number, matchId: number) =>
    request<{ ok: true }>(`/sessions/${sessionId}/assign-match`, {
      method: "POST",
      body: JSON.stringify({ matchId }),
    }),
  // Builds a custom match and adds it to the end of the actual queue.
  createCustomMatch: (sessionId: number, team1: [number, number], team2: [number, number]) =>
    request<Match>(`/sessions/${sessionId}/custom-match`, {
      method: "POST",
      body: JSON.stringify({ team1, team2 }),
    }),
  reorderQueue: (sessionId: number, order: number[]) =>
    request<{ ok: true }>(`/sessions/${sessionId}/queue/reorder`, {
      method: "POST",
      body: JSON.stringify({ order }),
    }),
  submitScore: (matchId: number, score1: number, score2: number) =>
    request<{ ok: true }>(`/matches/${matchId}`, { method: "PATCH", body: JSON.stringify({ score1, score2 }) }),
  // ratingRollback reports what happened to each registered player's rating as
  // a result of removing this match -- see worker/lib/ratingIntegration.ts's
  // rollbackMatchRating. rolledBack: their rating was restored to what it was
  // right before this match. skipped: left untouched on purpose (with why) --
  // currently only because they've played a newer rated match since, which
  // would make an automatic rollback unsafe.
  deleteMatch: (matchId: number) =>
    request<{
      ok: true;
      ratingRollback?: { rolledBack: string[]; skipped: { username: string; reason: string }[] };
    }>(`/matches/${matchId}`, { method: "DELETE" }),
};

export const LEVELS: Level[] = ["A", "B", "C", "D", "E"];

// Cute egg-to-chicken icons for each skill level.
export const LEVEL_ICON: Record<Level, string> = {
  E: "🥚",
  D: "🐣",
  C: "🐤",
  B: "🐔",
  A: "🍗",
};

export const LEVEL_LABEL: Record<Level, string> = {
  E: "Egg",
  D: "Hatchling",
  C: "Chick",
  B: "Chicken",
  A: "Roast",
};

// Rank badge artwork for each rating tier (worker/lib/rating.ts's mmrToTier)
// -- purely presentational, not used in any rating math, same spirit as
// LEVEL_ICON above. The art is drawn to glow against a dark background (see
// .rank-badge-card in styles.css) -- its fine white/gold linework all but
// disappears on this app's normal light cream cards, so always pair it with
// that dark backdrop rather than dropping it onto a plain card.
import fledglingBadge from "./assets/ranks/fledgling.png";
import rallyBadge from "./assets/ranks/rally.png";
import smashBadge from "./assets/ranks/smash.png";
import aceBadge from "./assets/ranks/ace.png";
import championBadge from "./assets/ranks/champion.png";
import legendBadge from "./assets/ranks/legend.png";

export const TIER_BADGE_IMAGE: Record<string, string> = {
  Fledgling: fledglingBadge,
  Rally: rallyBadge,
  Smash: smashBadge,
  Ace: aceBadge,
  Champion: championBadge,
  Legend: legendBadge,
};

// Lowest to highest, mirrors the MMR thresholds in worker/lib/rating.ts's
// mmrToTier -- kept here (not derived from TIER_BADGE_IMAGE's key order,
// which isn't guaranteed) so rank-up detection has one clear source of truth.
const TIER_ORDER = ["Fledgling", "Rally", "Smash", "Ace", "Champion", "Legend"];

// A single comparable number for a (tier, division) pair -- higher is always
// better. Division only applies to the four middle tiers; Fledgling and
// Legend pass division: null and just compare by tier. Used by PlayerHome's
// RankTab to notice "you're higher than you were last time you checked" and
// show a congratulations banner.
export function rankScore(tier: string, division: "I" | "II" | "III" | null): number {
  const tierIndex = TIER_ORDER.indexOf(tier);
  const divisionIndex = division === "I" ? 2 : division === "II" ? 1 : 0; // "III" or null -> 0
  return tierIndex * 3 + divisionIndex;
}
