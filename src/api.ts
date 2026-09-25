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

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "application/json");
  const token = hostToken();
  if (token) headers.set("x-host-token", token);
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
