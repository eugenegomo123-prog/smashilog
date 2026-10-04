export type Level = "A" | "B" | "C" | "D" | "E";
export type PlayerStatus = "active" | "resting" | "inactive";
export type PlayingMode = "competitive" | "chill";

export interface Session {
  id: number;
  name: string;
  status: "active" | "ended";
  courtCount: number;
  courtLabels: string[];
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
  createdAt: string;
}

export interface Match {
  id: number;
  sessionId: number;
  courtLabel: string;
  team1: number[];
  team2: number[];
  status: "ongoing" | "completed" | "suggested" | "queued";
  score1: number | null;
  score2: number | null;
  startedAt: string;
  endedAt: string | null;
  queuePosition: number | null;
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
      activeParticipation: { sessionId: number; sessionName: string; approved: boolean } | null;
    }>("/me"),
  getOverallStats: () =>
    request<{
      sessionsPlayed: number;
      gamesPlayed: number;
      wins: number;
      losses: number;
      pointsFor: number;
      averageScore: number;
      highestScore: number;
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
    }>("/me/rating"),
  getJoinableSessions: () =>
    request<{ id: number; name: string; playerCount: number; alreadyJoined: boolean; approved: boolean }[]>(
      "/me/joinable-sessions",
    ),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/me/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
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
      }[];
    }>(`/me/ranking?scope=${encodeURIComponent(scope)}`).then((r) => r.entries),
  getMyPlayerInSession: (sessionId: number) =>
    request<{ player: Player | null }>(`/sessions/${sessionId}/my-player`).then((r) => r.player),
  requestToJoinAsAccount: (sessionId: number, requestedLevel: Level) =>
    request<Player>(`/sessions/${sessionId}/players`, {
      method: "POST",
      body: JSON.stringify({ requestedLevel }),
    }),

  listSessions: () => request<Session[]>("/sessions"),
  createSession: (name: string, courtCount: number) =>
    request<Session>("/sessions", { method: "POST", body: JSON.stringify({ name, courtCount }) }),
  getSession: (id: number) => request<Session>(`/sessions/${id}`),
  updateSession: (id: number, updates: Partial<Pick<Session, "status" | "name" | "courtCount" | "courtLabels">>) =>
    request<Session>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(updates) }),
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
  deleteMatch: (matchId: number) => request<{ ok: true }>(`/matches/${matchId}`, { method: "DELETE" }),
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
