import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, matches, players, sessions } from "../db/schema";
import { createHostToken, requireHost } from "./lib/auth";
import { createPlayerToken, createRegistrationToken, requirePlayer, verifyRegistrationToken } from "./lib/playerAuth";
import {
  computeAllTimeRanking,
  computeMonthRanking,
  computeOverallStats,
  computeSessionDetail,
  computeSessionHistory,
  rankAccounts,
} from "./lib/accountStats";
import { hashPassword, verifyPassword } from "./lib/passwords";
import { regenerateQueue } from "./lib/regenerate";
import { fillOpenCourtsFromQueue, nextQueuePosition, MAX_QUEUE_LENGTH } from "./lib/queue";
import { playerIdsUnavailable, recomputeSessionStats } from "./lib/stats";

// Bindings available on `c.env`, set in wrangler.jsonc / as Worker secrets.
// `ASSETS` is the binding for the static frontend build (see wrangler.jsonc "assets").
type Bindings = {
  DATABASE_URL: string;
  HOST_PASSWORD?: string;
  PLAYER_AUTH_SECRET?: string;
  ASSETS: Fetcher;
};

const LEVELS = ["A", "B", "C", "D", "E"];
const STATUSES = ["active", "resting", "inactive"];
const PLAYING_MODES = ["competitive", "chill"];

const app = new Hono<{ Bindings: Bindings }>();

function hostSecret(env: Bindings): string {
  return env.HOST_PASSWORD || "queuemaster";
}

// Unlike hostSecret, this has no guessable fallback -- a forged registration token
// would let someone create accounts without ever scanning a real host's QR code,
// so these endpoints refuse to run until a real secret is set.
function playerAuthSecret(env: Bindings): string | null {
  return env.PLAYER_AUTH_SECRET || null;
}

// POST /api/host-auth
app.post("/api/host-auth", async (c) => {
  const body = await c.req.json().catch(() => ({ password: "" }));
  const expected = hostSecret(c.env);
  if (body.password !== expected) {
    return c.json({ error: "Incorrect password" }, 401);
  }
  return c.json({ token: await createHostToken(expected) });
});

// POST /api/register -- create a player account. Requires a valid registration
// token, proving it came from a host's QR code.
app.post("/api/register", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const secret = playerAuthSecret(c.env);
  if (!secret) return c.json({ error: "Player accounts aren't set up yet on this server." }, 500);

  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  if (!(await verifyRegistrationToken(token, secret))) {
    return c.json(
      { error: "This registration link is invalid or has expired -- ask your host for a new QR code." },
      400,
    );
  }
  if (username.length < 3 || username.length > 30) {
    return c.json({ error: "Username must be 3-30 characters" }, 400);
  }
  if (password.length < 6) {
    return c.json({ error: "Password must be at least 6 characters" }, 400);
  }

  const [existing] = await db.select().from(accounts).where(eq(accounts.username, username));
  if (existing) {
    return c.json({ error: "That username is already taken" }, 400);
  }

  const { hash, salt } = await hashPassword(password);
  const [created] = await db
    .insert(accounts)
    .values({ username, passwordHash: hash, passwordSalt: salt })
    .returning();

  const playerToken = await createPlayerToken(created.id, secret);
  return c.json({ token: playerToken, username: created.username }, 201);
});

// POST /api/login
app.post("/api/login", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const secret = playerAuthSecret(c.env);
  if (!secret) return c.json({ error: "Player accounts aren't set up yet on this server." }, 500);

  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  const [account] = await db.select().from(accounts).where(eq(accounts.username, username));
  if (!account || !(await verifyPassword(password, account.passwordHash, account.passwordSalt))) {
    return c.json({ error: "Incorrect username or password" }, 401);
  }

  const playerToken = await createPlayerToken(account.id, secret);
  return c.json({ token: playerToken, username: account.username });
});

// GET /api/me -- basic account info, plus whether this account currently has an
// active-session participation (for "Return to session" on the player's home page).
app.get("/api/me", async (c) => {
  const secret = playerAuthSecret(c.env);
  const accountId = secret ? await requirePlayer(c.req.raw, secret) : null;
  if (!accountId) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) return c.text("Not found", 404);

  const myRows = await db.select().from(players).where(eq(players.accountId, accountId));
  let activeParticipation: { sessionId: number; sessionName: string; approved: boolean } | null = null;
  if (myRows.length > 0) {
    const sessionIds = [...new Set(myRows.map((p) => p.sessionId))];
    const mySessions = await db.select().from(sessions).where(inArray(sessions.id, sessionIds));
    const activeSession = mySessions.find((s) => s.status === "active");
    if (activeSession) {
      const myRow = myRows.find((p) => p.sessionId === activeSession.id)!;
      activeParticipation = { sessionId: activeSession.id, sessionName: activeSession.name, approved: myRow.approved };
    }
  }

  return c.json({ username: account.username, activeParticipation });
});

// GET /api/me/stats -- totals across every session this account has ever joined.
app.get("/api/me/stats", async (c) => {
  const secret = playerAuthSecret(c.env);
  const accountId = secret ? await requirePlayer(c.req.raw, secret) : null;
  if (!accountId) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const stats = await computeOverallStats(db, accountId);
  return c.json(stats);
});

// GET /api/me/ranking?scope=all|YYYY-MM -- cross-account leaderboard.
app.get("/api/me/ranking", async (c) => {
  const secret = playerAuthSecret(c.env);
  const accountId = secret ? await requirePlayer(c.req.raw, secret) : null;
  if (!accountId) return c.text("Unauthorized", 401);
  const scope = c.req.query("scope") || "all";
  if (scope !== "all" && !/^\d{4}-\d{2}$/.test(scope)) {
    return c.json({ error: 'scope must be "all" or "YYYY-MM"' }, 400);
  }
  const db = getDb(c.env.DATABASE_URL);
  const entries = scope === "all" ? await computeAllTimeRanking(db) : await computeMonthRanking(db, scope);
  return c.json({ scope, entries: rankAccounts(entries) });
});

// GET /api/me/history -- every session this account has played, most recent first.
app.get("/api/me/history", async (c) => {
  const secret = playerAuthSecret(c.env);
  const accountId = secret ? await requirePlayer(c.req.raw, secret) : null;
  if (!accountId) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const history = await computeSessionHistory(db, accountId);
  return c.json(history);
});

// GET /api/me/history/:sessionId -- detail view for one past (or current) session.
app.get("/api/me/history/:sessionId", async (c) => {
  const secret = playerAuthSecret(c.env);
  const accountId = secret ? await requirePlayer(c.req.raw, secret) : null;
  if (!accountId) return c.text("Unauthorized", 401);
  const sessionId = Number(c.req.param("sessionId"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);
  const detail = await computeSessionDetail(db, accountId, sessionId);
  if (!detail) return c.text("Not found", 404);
  return c.json(detail);
});

// GET /api/me/joinable-sessions -- active sessions, with a player count and whether
// this account has already requested/joined each one.
app.get("/api/me/joinable-sessions", async (c) => {
  const secret = playerAuthSecret(c.env);
  const accountId = secret ? await requirePlayer(c.req.raw, secret) : null;
  if (!accountId) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const activeSessions = await db.select().from(sessions).where(eq(sessions.status, "active"));
  const myRows = await db.select().from(players).where(eq(players.accountId, accountId));
  const myBySession = new Map(myRows.map((p) => [p.sessionId, p]));

  const result = [];
  for (const s of activeSessions) {
    const sessionPlayers = await db.select().from(players).where(eq(players.sessionId, s.id));
    const approvedCount = sessionPlayers.filter((p) => p.approved).length;
    const mine = myBySession.get(s.id);
    result.push({
      id: s.id,
      name: s.name,
      playerCount: approvedCount,
      alreadyJoined: !!mine,
      approved: mine?.approved ?? false,
    });
  }
  return c.json(result);
});

// POST /api/me/change-password
app.post("/api/me/change-password", async (c) => {
  const secret = playerAuthSecret(c.env);
  const accountId = secret ? await requirePlayer(c.req.raw, secret) : null;
  if (!accountId) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");
  if (newPassword.length < 6) return c.json({ error: "New password must be at least 6 characters" }, 400);

  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account || !(await verifyPassword(currentPassword, account.passwordHash, account.passwordSalt))) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }
  const { hash, salt } = await hashPassword(newPassword);
  await db.update(accounts).set({ passwordHash: hash, passwordSalt: salt }).where(eq(accounts.id, accountId));
  return c.json({ ok: true });
});

// POST /api/host/registration-token -- host generates a fresh player-registration
// QR token (24h expiry). Not tied to any one session.
app.post("/api/host/registration-token", async (c) => {
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const secret = playerAuthSecret(c.env);
  if (!secret) return c.json({ error: "Player accounts aren't set up yet on this server." }, 500);
  const token = await createRegistrationToken(secret);
  const expiresAt = Number(token.split(".")[0]);
  return c.json({ token, expiresAt });
});

// GET/POST /api/sessions
app.get("/api/sessions", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const all = await db.select().from(sessions).orderBy(desc(sessions.createdAt));
  return c.json(all);
});

app.post("/api/sessions", async (c) => {
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const courtCount = Math.max(1, Number(body.courtCount) || 4);
  if (!name) return c.json({ error: "Session name is required" }, 400);
  const courtLabels = Array.from({ length: courtCount }, (_, i) => `Court #${i + 1}`);
  const [created] = await db
    .insert(sessions)
    .values({ name, courtCount, courtLabels, status: "active" })
    .returning();
  return c.json(created, 201);
});

// GET/PATCH/DELETE /api/sessions/:id
app.get("/api/sessions/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);
  const [session] = await db.select().from(sessions).where(eq(sessions.id, id));
  if (!session) return c.text("Not found", 404);
  return c.json(session);
});

app.patch("/api/sessions/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.text("Invalid session id", 400);
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (body.status === "ended") {
    updates.status = "ended";
    updates.endedAt = new Date();
  }
  if (body.status === "active") {
    updates.status = "active";
    updates.endedAt = null;
  }
  if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
  if (Number.isFinite(Number(body.courtCount))) updates.courtCount = Number(body.courtCount);
  if (Array.isArray(body.courtLabels)) updates.courtLabels = body.courtLabels;
  if (Object.keys(updates).length === 0) return c.json({ error: "No valid fields" }, 400);
  const [updated] = await db.update(sessions).set(updates).where(eq(sessions.id, id)).returning();
  return c.json(updated);
});

app.delete("/api/sessions/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.text("Invalid session id", 400);
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  await db.delete(matches).where(eq(matches.sessionId, id));
  await db.delete(players).where(eq(players.sessionId, id));
  await db.delete(sessions).where(eq(sessions.id, id));
  return c.json({ ok: true });
});

// GET/POST /api/sessions/:id/players
app.get("/api/sessions/:id/players", async (c) => {
  const sessionId = Number(c.req.param("id"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);
  const list = await db.select().from(players).where(eq(players.sessionId, sessionId));
  return c.json(list);
});

app.post("/api/sessions/:id/players", async (c) => {
  const sessionId = Number(c.req.param("id"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const isHost = await requireHost(c.req.raw, hostSecret(c.env));
  const requestedLevel = LEVELS.includes(body.requestedLevel) ? body.requestedLevel : "C";

  // Registered-player path: identified by their account token, not a typed name.
  const secret = playerAuthSecret(c.env);
  const accountId = !isHost && secret ? await requirePlayer(c.req.raw, secret) : null;
  if (accountId) {
    const [existingRow] = await db
      .select()
      .from(players)
      .where(and(eq(players.sessionId, sessionId), eq(players.accountId, accountId)));
    if (existingRow) return c.json(existingRow, 200);

    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    if (!account) return c.json({ error: "Account not found" }, 404);

    const [created] = await db
      .insert(players)
      .values({
        sessionId,
        name: account.username,
        level: "C",
        requestedLevel,
        approved: false,
        status: "active",
        accountId,
      })
      .returning();
    return c.json(created, 201);
  }

  // Existing guest / host-adds-player path, unchanged.
  const name = String(body.name || "").trim();
  if (!name) return c.json({ error: "Name is required" }, 400);

  const [created] = await db
    .insert(players)
    .values({
      sessionId,
      name,
      level: isHost ? requestedLevel : "C",
      requestedLevel: isHost ? null : requestedLevel,
      approved: isHost,
      status: "active",
    })
    .returning();
  return c.json(created, 201);
});

// GET /api/sessions/:id/my-player -- does the logged-in account already have a
// player row in this session? Used to resume across devices instead of guessing
// from browser storage.
app.get("/api/sessions/:id/my-player", async (c) => {
  const sessionId = Number(c.req.param("id"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const secret = playerAuthSecret(c.env);
  const accountId = secret ? await requirePlayer(c.req.raw, secret) : null;
  if (!accountId) return c.json({ player: null });
  const db = getDb(c.env.DATABASE_URL);
  const [player] = await db
    .select()
    .from(players)
    .where(and(eq(players.sessionId, sessionId), eq(players.accountId, accountId)));
  return c.json({ player: player ?? null });
});

// GET /api/sessions/:id/matches
app.get("/api/sessions/:id/matches", async (c) => {
  const sessionId = Number(c.req.param("id"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);

  const all = await db.select().from(matches).where(eq(matches.sessionId, sessionId));
  const ongoing = all.filter((m) => m.status === "ongoing");
  const suggested = all.filter((m) => m.status === "suggested");
  const queued = all
    .filter((m) => m.status === "queued")
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  const history = all
    .filter((m) => m.status === "completed")
    .sort((a, b) => new Date(b.endedAt as unknown as string).getTime() - new Date(a.endedAt as unknown as string).getTime());

  return c.json({ ongoing, history, suggested, queued });
});

// POST /api/sessions/:id/regenerate -- rebuild the suggested-matches pool. Can be
// called any time; it only ever touches "suggested" rows.
app.post("/api/sessions/:id/regenerate", async (c) => {
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const sessionId = Number(c.req.param("id"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);
  await regenerateQueue(db, sessionId);
  return c.json({ ok: true });
});

// POST /api/sessions/:id/assign-match -- host moves a suggested match into the actual
// queue (it no longer picks a court directly; the queue fills courts automatically).
app.post("/api/sessions/:id/assign-match", async (c) => {
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const sessionId = Number(c.req.param("id"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const matchId = Number(body.matchId);
  if (!Number.isFinite(matchId)) return c.json({ error: "matchId is required" }, 400);

  const [suggested] = await db.select().from(matches).where(eq(matches.id, matchId));
  if (!suggested || suggested.sessionId !== sessionId || suggested.status !== "suggested") {
    return c.json({ error: "That suggestion is no longer available -- try regenerating." }, 400);
  }

  const allMatches = await db.select().from(matches).where(eq(matches.sessionId, sessionId));
  const queuedCount = allMatches.filter((m) => m.status === "queued").length;
  if (queuedCount >= MAX_QUEUE_LENGTH) {
    return c.json({ error: `Queue is full (max ${MAX_QUEUE_LENGTH}) -- remove or play one first.` }, 400);
  }

  const involved = new Set<number>([...(suggested.team1 as number[]), ...(suggested.team2 as number[])]);
  const sessionPlayers = await db.select().from(players).where(eq(players.sessionId, sessionId));
  const playerMap = new Map(sessionPlayers.map((p) => [p.id, p]));
  const unavailable = await playerIdsUnavailable(db, sessionId);
  for (const pid of involved) {
    const p = playerMap.get(pid);
    if (!p || !p.approved || p.status !== "active") {
      return c.json({ error: "One of these players is no longer active -- try regenerating." }, 400);
    }
    if (unavailable.has(pid)) {
      return c.json({ error: "One of these players is already on a court or queued -- try regenerating." }, 400);
    }
  }

  const position = await nextQueuePosition(db, sessionId);
  await db
    .update(matches)
    .set({ status: "queued", queuePosition: position })
    .where(eq(matches.id, matchId));

  // Any other suggestion sharing a player with the one just queued is now stale.
  const stale = allMatches.filter(
    (m) =>
      m.status === "suggested" &&
      m.id !== matchId &&
      [...(m.team1 as number[]), ...(m.team2 as number[])].some((pid) => involved.has(pid)),
  );
  for (const m of stale) {
    await db.delete(matches).where(eq(matches.id, m.id));
  }

  await fillOpenCourtsFromQueue(db, sessionId);
  return c.json({ ok: true });
});

// POST /api/sessions/:id/custom-match -- host manually builds both teams and adds
// them to the end of the actual queue (also no court picked here anymore).
app.post("/api/sessions/:id/custom-match", async (c) => {
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const sessionId = Number(c.req.param("id"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const team1 = Array.isArray(body.team1) ? body.team1.map(Number) : [];
  const team2 = Array.isArray(body.team2) ? body.team2.map(Number) : [];
  if (team1.length !== 2 || team2.length !== 2) {
    return c.json({ error: "team1 and team2 must each have 2 players" }, 400);
  }
  const allIds = [...team1, ...team2];
  if (new Set(allIds).size !== 4) return c.json({ error: "Pick 4 different players" }, 400);

  const allMatches = await db.select().from(matches).where(eq(matches.sessionId, sessionId));
  const queuedCount = allMatches.filter((m) => m.status === "queued").length;
  if (queuedCount >= MAX_QUEUE_LENGTH) {
    return c.json({ error: `Queue is full (max ${MAX_QUEUE_LENGTH}) -- remove or play one first.` }, 400);
  }

  const unavailable = await playerIdsUnavailable(db, sessionId);
  if (allIds.some((pid) => unavailable.has(pid))) {
    return c.json({ error: "One of these players is already on a court or queued" }, 400);
  }

  const sessionPlayers = await db.select().from(players).where(eq(players.sessionId, sessionId));
  const validIds = new Set(sessionPlayers.filter((p) => p.approved && p.status === "active").map((p) => p.id));
  if (allIds.some((pid) => !validIds.has(pid))) {
    return c.json({ error: "Unknown or inactive player" }, 400);
  }

  // A manually-queued match makes any suggestion sharing these players stale.
  const involved = new Set(allIds);
  const stale = allMatches.filter(
    (m) =>
      m.status === "suggested" &&
      [...(m.team1 as number[]), ...(m.team2 as number[])].some((pid) => involved.has(pid)),
  );
  for (const m of stale) {
    await db.delete(matches).where(eq(matches.id, m.id));
  }

  const position = await nextQueuePosition(db, sessionId);
  const [created] = await db
    .insert(matches)
    .values({ sessionId, courtLabel: "", team1, team2, status: "queued", queuePosition: position })
    .returning();

  await fillOpenCourtsFromQueue(db, sessionId);
  return c.json(created, 201);
});

// POST /api/sessions/:id/queue/reorder -- host reorders the actual queue. Body is the
// full desired order (all currently queued match ids, in the new sequence).
app.post("/api/sessions/:id/queue/reorder", async (c) => {
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const sessionId = Number(c.req.param("id"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const order = Array.isArray(body.order) ? body.order.map(Number) : [];

  const current = await db.select().from(matches).where(eq(matches.sessionId, sessionId));
  const currentQueued = current.filter((m) => m.status === "queued");
  const currentIds = new Set(currentQueued.map((m) => m.id));
  if (order.length !== currentQueued.length || !order.every((id: number) => currentIds.has(id))) {
    return c.json({ error: "Order must include exactly the currently queued matches" }, 400);
  }

  for (let i = 0; i < order.length; i++) {
    await db.update(matches).set({ queuePosition: i }).where(eq(matches.id, order[i]));
  }

  await fillOpenCourtsFromQueue(db, sessionId);
  return c.json({ ok: true });
});

// PATCH/DELETE /api/players/:id
app.patch("/api/players/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.text("Invalid player id", 400);
  const db = getDb(c.env.DATABASE_URL);
  const isHost = await requireHost(c.req.raw, hostSecret(c.env));
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};

  // Self-service: any participant can change their own level, status, playing mode, or preferred partner.
  if (LEVELS.includes(body.level)) updates.level = body.level;
  if (STATUSES.includes(body.status)) updates.status = body.status;
  if (PLAYING_MODES.includes(body.playingMode)) updates.playingMode = body.playingMode;
  if (body.preferredPartnerId === null) {
    updates.preferredPartnerId = null;
  } else if (body.preferredPartnerId !== undefined && Number.isFinite(Number(body.preferredPartnerId))) {
    const partnerId = Number(body.preferredPartnerId);
    if (partnerId === id) {
      return c.json({ error: "Can't set yourself as your own preferred partner" }, 400);
    }
    const [existing] = await db.select().from(players).where(eq(players.id, id));
    const [partner] = await db.select().from(players).where(eq(players.id, partnerId));
    if (!existing || !partner || partner.sessionId !== existing.sessionId || !partner.approved) {
      return c.json({ error: "Unknown player" }, 400);
    }
    updates.preferredPartnerId = partnerId;
  }

  // Host-only: approve join requests, override level/status/name.
  if (isHost) {
    if (typeof body.approved === "boolean") updates.approved = body.approved;
    if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
  } else if (typeof body.approved === "boolean") {
    return c.text("Unauthorized", 401);
  }

  if (Object.keys(updates).length === 0) return c.json({ error: "No valid fields" }, 400);
  const [updated] = await db.update(players).set(updates).where(eq(players.id, id)).returning();
  if (!updated) return c.text("Not found", 404);
  return c.json(updated);
});

app.delete("/api/players/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.text("Invalid player id", 400);
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  await db.delete(players).where(eq(players.id, id));
  return c.json({ ok: true });
});

// PATCH /api/matches/:id -- submit or edit a score
app.patch("/api/matches/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.text("Invalid match id", 400);
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);

  const [match] = await db.select().from(matches).where(eq(matches.id, id));
  if (!match) return c.text("Not found", 404);

  const body = await c.req.json().catch(() => ({}));
  const score1 = Number(body.score1);
  const score2 = Number(body.score2);
  if (!Number.isFinite(score1) || !Number.isFinite(score2) || score1 < 0 || score2 < 0) {
    return c.json({ error: "score1 and score2 must be non-negative numbers" }, 400);
  }

  const wasAlreadyCompleted = match.status === "completed";
  await db
    .update(matches)
    .set({
      score1,
      score2,
      status: "completed",
      endedAt: wasAlreadyCompleted ? match.endedAt : new Date(),
    })
    .where(eq(matches.id, id));

  // Recompute from full history rather than patching deltas -- correct for both a fresh
  // completion and a later score edit.
  await recomputeSessionStats(db, match.sessionId);

  // A fresh completion frees up a court -- pull the front of the actual queue onto it.
  if (!wasAlreadyCompleted) {
    await fillOpenCourtsFromQueue(db, match.sessionId);
  }

  return c.json({ ok: true });
});

// DELETE /api/matches/:id -- remove a match (in-progress, queued, or completed).
// Stats are always recomputed afterward; harmless when the match had no score yet.
app.delete("/api/matches/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.text("Invalid match id", 400);
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const [match] = await db.select().from(matches).where(eq(matches.id, id));
  if (!match) return c.text("Not found", 404);
  if (match.status === "suggested") {
    return c.json({ error: "Suggested matches aren't deleted this way -- try regenerating." }, 400);
  }
  const wasOngoing = match.status === "ongoing";
  await db.delete(matches).where(eq(matches.id, id));
  await recomputeSessionStats(db, match.sessionId);
  if (wasOngoing) {
    await fillOpenCourtsFromQueue(db, match.sessionId);
  }
  return c.json({ ok: true });
});

// Anything that isn't an /api/* route: hand off to the static asset binding, which
// also applies the SPA fallback configured in wrangler.jsonc (not_found_handling).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
