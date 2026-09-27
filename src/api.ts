export type Level = "A" | "B" | "C" | "D" | "E";
export type PlayerStatus = "active" | "resting" | "inactive";

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
  accountId: number | null;
  level: Level;
  requestedLevel: Level | null;
  status: PlayerStatus;
  approved: boolean;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  currentStreak: number;
  gamesPlayed: number;
  lastMatchEndedAt: string | null;
  createdAt: string;
}

export interface Match {
  id: number;
  sessionId: number;
  courtLabel: string;
  team1: number[];
  team2: number[];
  status: "ongoing" | "completed";
  score1: number | null;
  score2: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ProjectedPlayer {
  id: number;
  level: Level;
}

export interface ProjectedMatch {
  team1: ProjectedPlayer[];
  team2: ProjectedPlayer[];
}

// --- Player accounts ---------------------------------------------------------------

export interface Account {
  id: number;
  username: string;
  name: string;
}

export interface ActiveSessionInfo {
  sessionId: number;
  sessionName: string;
  playerId: number;
}

export interface MeResponse {
  account: Account;
  activeSession: ActiveSessionInfo | null;
}

export interface OverallStats {
  sessionsPlayed: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  totalPoints: number;
  averageScore: number;
  highestScore: number;
}

export interface HistoryEntry {
  sessionId: number;
  sessionName: string;
  sessionStatus: "active" | "ended";
  date: string;
  playerId: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  totalPoints: number;
}

export interface RankingEntry {
  accountId: number;
  name: string;
  wins: number;
  losses: number;
  gamesPlayed: number;
  totalPoints: number;
  winPct: number;
}

export interface ActiveSessionForAccount {
  id: number;
  name: string;
  playerCount: number;
  alreadyJoined: boolean;
  pendingApproval: boolean;
}

// The localStorage key a guest (or a registered player) uses to remember "which player
// row am I" for a given session. Defined here (rather than in a page component) so both
// the guest join flow and the account flow can share exactly one implementation.
export function playerKey(sessionId: number): string {
  return `smashilog_player_${sessionId}`;
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
  const hToken = hostToken();
  if (hToken) headers.set("x-host-token", hToken);
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
    updates: Partial<Pick<Player, "level" | "status" | "approved" | "name">>,
  ) => request<Player>(`/players/${id}`, { method: "PATCH", body: JSON.stringify(updates) }),
  removePlayer: (id: number) => request<{ ok: true }>(`/players/${id}`, { method: "DELETE" }),

  getMatches: (sessionId: number) =>
    request<{ ongoing: Match[]; history: Match[]; queue: ProjectedMatch[] }>(`/sessions/${sessionId}/matches`),
  regenerateQueue: (sessionId: number) =>
    request<{ ok: true }>(`/sessions/${sessionId}/regenerate`, { method: "POST" }),
  submitScore: (matchId: number, score1: number, score2: number) =>
    request<{ ok: true }>(`/matches/${matchId}`, { method: "PATCH", body: JSON.stringify({ score1, score2 }) }),

  // --- Player accounts ---------------------------------------------------------

  signup: (token: string, username: string, password: string, name: string) =>
    request<{ token: string; account: Account }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ token, username, password, name }),
    }),
  login: (username: string, password: string) =>
    request<{ token: string; account: Account }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  setPlayerToken: (token: string) => localStorage.setItem("smashilog_player_token", token),
  clearPlayerToken: () => localStorage.removeItem("smashilog_player_token"),
  isPlayerLoggedIn: () => !!playerToken(),

  getMe: () => request<MeResponse>("/accounts/me"),
  getOverallStats: () => request<OverallStats>("/accounts/me/overall-stats"),
  getHistory: () => request<HistoryEntry[]>("/accounts/me/history"),
  listActiveSessionsForAccount: () => request<ActiveSessionForAccount[]>("/accounts/me/active-sessions"),
  joinSessionAsAccount: (sessionId: number) =>
    request<Player>(`/sessions/${sessionId}/join-as-account`, { method: "POST" }),

  // Figures out "which player row, in this session, is me" -- checking the local guest
  // key first (cheap, and already set for anyone who joined the normal way), and only
  // falling back to an account lookup (and caching the result the same way) if that's
  // empty and the visitor is logged in as a registered player.
  resolveMyPlayerId: async (sessionId: number): Promise<number | null> => {
    const stored = localStorage.getItem(playerKey(sessionId));
    if (stored) return Number(stored);
    if (!playerToken()) return null;
    const { playerId } = await request<{ playerId: number | null }>(`/accounts/me/player-in-session/${sessionId}`);
    if (playerId) localStorage.setItem(playerKey(sessionId), String(playerId));
    return playerId;
  },

  getRanking: (period: string) => request<RankingEntry[]>(`/ranking?period=${encodeURIComponent(period)}`),
  getRankingMonths: () => request<string[]>("/ranking/months"),

  getRegistrationToken: () => request<{ token: string | null }>("/host/registration-token"),
  regenerateRegistrationToken: () =>
    request<{ token: string }>("/host/registration-token/regenerate", { method: "POST" }),
};

export const LEVELS: Level[] = ["A", "B", "C", "D", "E"];
