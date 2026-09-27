import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, appConfig, matches, players, sessions } from "../db/schema";
import { createHostToken, createPlayerToken, requireHost, requirePlayer } from "./lib/auth";
import { computeHistory, computeOverallStats, computeRanking, listRankingMonths } from "./lib/accountStats";
import { projectMatches, sortByPriority, type PlayerForMatchmaking } from "./lib/matchmaking";
import { hashPassword, verifyPassword } from "./lib/password";
import { regenerateQueue } from "./lib/regenerate";
import { playerIdsInOngoingMatches, recomputeSessionStats } from "./lib/stats";

// Bindings available on `c.env`, set in wrangler.jsonc / as Worker secrets.
// `ASSETS` is the binding for the static frontend build (see wrangler.jsonc "assets").
type Bindings = {
  DATABASE_URL: string;
  HOST_PASSWORD?: string;
  ASSETS: Fetcher;
};

const LEVELS = ["A", "B", "C", "D", "E"];
const STATUSES = ["active", "resting", "inactive"];

const app = new Hono<{ Bindings: Bindings }>();

function hostSecret(env: Bindings): string {
  return env.HOST_PASSWORD || "queuemaster";
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
  const name = String(body.name || "").trim();
  if (!name) return c.json({ error: "Name is required" }, 400);
  const isHost = await requireHost(c.req.raw, hostSecret(c.env));
  const requestedLevel = LEVELS.includes(body.requestedLevel) ? body.requestedLevel : "C";

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

// GET /api/sessions/:id/matches
app.get("/api/sessions/:id/matches", async (c) => {
  const sessionId = Number(c.req.param("id"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);

  const all = await db.select().from(matches).where(eq(matches.sessionId, sessionId));
  const ongoing = all.filter((m) => m.status === "ongoing");
  const history = all
    .filter((m) => m.status === "completed")
    .sort((a, b) => new Date(b.endedAt as unknown as string).getTime() - new Date(a.endedAt as unknown as string).getTime());

  const allPlayers = await db.select().from(players).where(eq(players.sessionId, sessionId));
  const busy = await playerIdsInOngoingMatches(db, sessionId);
  const pool: PlayerForMatchmaking[] = sortByPriority(
    allPlayers
      .filter((p) => p.approved && p.status === "active" && !busy.has(p.id))
      .map((p) => ({
        id: p.id,
        level: p.level,
        currentStreak: p.currentStreak,
        pointsFor: p.pointsFor,
        pointsAgainst: p.pointsAgainst,
        gamesPlayed: p.gamesPlayed,
        lastMatchEndedAt: p.lastMatchEndedAt ? (p.lastMatchEndedAt as unknown as Date).toISOString() : null,
      })),
  );
  const queue = projectMatches(pool, 8);

  return c.json({ ongoing, history, queue });
});

// POST /api/sessions/:id/regenerate
app.post("/api/sessions/:id/regenerate", async (c) => {
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const sessionId = Number(c.req.param("id"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);
  await regenerateQueue(db, sessionId);
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

  // Self-service: any participant can change their own level or status.
  if (LEVELS.includes(body.level)) updates.level = body.level;
  if (STATUSES.includes(body.status)) updates.status = body.status;

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

// PATCH /api/matches/:id
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

  // A fresh completion frees up a court; re-run the queue to fill it immediately.
  if (!wasAlreadyCompleted) {
    await regenerateQueue(db, match.sessionId);
  }

  return c.json({ ok: true });
});

// --- Player accounts ---------------------------------------------------------------
// Everything below this line is new: registered-player login/signup, the host's QR
// registration token, and the account-scoped stats/ranking/history/join endpoints.
// None of it touches the guest/participant flow above -- a registered player just ends
// up with a normal `players` row (like a guest) that additionally has `accountId` set.

// Host-only: view or regenerate the player registration token (what the sign-up QR
// code encodes as `${origin}/signup?token=...`).
app.get("/api/host/registration-token", async (c) => {
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const [config] = await db.select().from(appConfig);
  return c.json({ token: config?.registrationToken ?? null });
});

app.post("/api/host/registration-token/regenerate", async (c) => {
  if (!(await requireHost(c.req.raw, hostSecret(c.env)))) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const token = crypto.randomUUID().replace(/-/g, "");
  const [existing] = await db.select().from(appConfig);
  if (existing) {
    await db.update(appConfig).set({ registrationToken: token, updatedAt: new Date() }).where(eq(appConfig.id, existing.id));
  } else {
    await db.insert(appConfig).values({ registrationToken: token });
  }
  return c.json({ token });
});

// POST /api/auth/signup -- requires the current registration token (from the QR code).
app.post("/api/auth/signup", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim();

  const [config] = await db.select().from(appConfig);
  if (!config || !token || token !== config.registrationToken) {
    return c.json({ error: "Invalid or missing registration code. Ask the host for the QR code." }, 401);
  }
  if (!username || username.length < 3) return c.json({ error: "Username must be at least 3 characters" }, 400);
  if (!password || password.length < 6) return c.json({ error: "Password must be at least 6 characters" }, 400);
  if (!name) return c.json({ error: "Display name is required" }, 400);

  const [existing] = await db.select().from(accounts).where(eq(accounts.username, username));
  if (existing) return c.json({ error: "That username is already taken" }, 409);

  const { salt, hash } = await hashPassword(password);
  const [created] = await db
    .insert(accounts)
    .values({ username, passwordSalt: salt, passwordHash: hash, name })
    .returning();

  const playerToken = await createPlayerToken(created.id, hostSecret(c.env));
  return c.json(
    { token: playerToken, account: { id: created.id, username: created.username, name: created.name } },
    201,
  );
});

app.post("/api/auth/login", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");

  const [account] = await db.select().from(accounts).where(eq(accounts.username, username));
  if (!account || !(await verifyPassword(password, account.passwordSalt, account.passwordHash))) {
    return c.json({ error: "Incorrect username or password" }, 401);
  }
  const playerToken = await createPlayerToken(account.id, hostSecret(c.env));
  return c.json({ token: playerToken, account: { id: account.id, username: account.username, name: account.name } });
});

// GET /api/accounts/me -- the logged-in player's info, plus whether they're already in
// an active session (so the app can offer "Return to Session" instead of "Join").
app.get("/api/accounts/me", async (c) => {
  const accountId = await requirePlayer(c.req.raw, hostSecret(c.env));
  if (!accountId) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) return c.text("Not found", 404);

  const myPlayerRows = await db.select().from(players).where(eq(players.accountId, accountId));
  let activeSession: { sessionId: number; sessionName: string; playerId: number } | null = null;
  if (myPlayerRows.length > 0) {
    const sessionIds = [...new Set(myPlayerRows.map((p) => p.sessionId))];
    const relatedSessions = await db.select().from(sessions).where(inArray(sessions.id, sessionIds));
    const active = relatedSessions.find((s) => s.status === "active");
    if (active) {
      const row = myPlayerRows.find((p) => p.sessionId === active.id)!;
      activeSession = { sessionId: active.id, sessionName: active.name, playerId: row.id };
    }
  }

  return c.json({ account: { id: account.id, username: account.username, name: account.name }, activeSession });
});

app.get("/api/accounts/me/overall-stats", async (c) => {
  const accountId = await requirePlayer(c.req.raw, hostSecret(c.env));
  if (!accountId) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  return c.json(await computeOverallStats(db, accountId));
});

app.get("/api/accounts/me/history", async (c) => {
  const accountId = await requirePlayer(c.req.raw, hostSecret(c.env));
  if (!accountId) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  return c.json(await computeHistory(db, accountId));
});

// Resolves which per-session player row (if any) belongs to the logged-in account for a
// given session -- used by ParticipantSession so a registered player's "my dashboard"
// tab works even on a device that never went through the guest join flow for it.
app.get("/api/accounts/me/player-in-session/:sessionId", async (c) => {
  const accountId = await requirePlayer(c.req.raw, hostSecret(c.env));
  if (!accountId) return c.text("Unauthorized", 401);
  const sessionId = Number(c.req.param("sessionId"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .select()
    .from(players)
    .where(and(eq(players.accountId, accountId), eq(players.sessionId, sessionId)));
  return c.json({ playerId: row?.id ?? null });
});

app.get("/api/accounts/me/active-sessions", async (c) => {
  const accountId = await requirePlayer(c.req.raw, hostSecret(c.env));
  if (!accountId) return c.text("Unauthorized", 401);
  const db = getDb(c.env.DATABASE_URL);
  const activeSessions = await db.select().from(sessions).where(eq(sessions.status, "active"));
  const allPlayers = await db.select().from(players);

  const result = activeSessions.map((s) => {
    const inThisSession = allPlayers.filter((p) => p.sessionId === s.id);
    const mine = inThisSession.find((p) => p.accountId === accountId);
    return {
      id: s.id,
      name: s.name,
      playerCount: inThisSession.filter((p) => p.approved).length,
      alreadyJoined: !!mine,
      pendingApproval: mine ? !mine.approved : false,
    };
  });
  return c.json(result);
});

// POST /api/sessions/:id/join-as-account -- same approval flow as a guest join request
// (creates an unapproved players row for the host to approve), but linked to the
// logged-in account. Idempotent: calling it again for a session already joined just
// returns the existing row, so re-tapping "Join"/"Return" never creates duplicates.
app.post("/api/sessions/:id/join-as-account", async (c) => {
  const accountId = await requirePlayer(c.req.raw, hostSecret(c.env));
  if (!accountId) return c.text("Unauthorized", 401);
  const sessionId = Number(c.req.param("id"));
  if (!Number.isFinite(sessionId)) return c.text("Invalid session id", 400);
  const db = getDb(c.env.DATABASE_URL);

  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return c.text("Not found", 404);
  if (session.status !== "active") return c.json({ error: "This session is not active" }, 400);

  const [existing] = await db
    .select()
    .from(players)
    .where(and(eq(players.accountId, accountId), eq(players.sessionId, sessionId)));
  if (existing) return c.json(existing);

  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) return c.text("Account not found", 404);

  const [created] = await db
    .insert(players)
    .values({
      sessionId,
      name: account.name,
      accountId,
      requestedLevel: "C",
      approved: false,
      status: "active",
    })
    .returning();
  return c.json(created, 201);
});

// GET /api/ranking?period=all|YYYY-MM -- public, read-only aggregate (no player info
// beyond display name), same as the existing per-session ranking table.
app.get("/api/ranking", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const period = c.req.query("period") || "all";
  return c.json(await computeRanking(db, period));
});

app.get("/api/ranking/months", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  return c.json(await listRankingMonths(db));
});

// Anything that isn't an /api/* route: hand off to the static asset binding, which
// also applies the SPA fallback configured in wrangler.jsonc (not_found_handling).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
