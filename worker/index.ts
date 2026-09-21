import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { matches, players, sessions } from "../db/schema";
import { createHostToken, requireHost } from "./lib/auth";
import { projectMatches, sortByPriority, type PlayerForMatchmaking } from "./lib/matchmaking";
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

// Anything that isn't an /api/* route: hand off to the static asset binding, which
// also applies the SPA fallback configured in wrangler.jsonc (not_found_handling).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
