import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import { matches, players, sessions } from "../../db/schema";
import { planAutoQueue, selectMatchesToStart, type AutoMatchInput, type AutoPlayerInput } from "./autoqueue";
import { isCourtOccupied, normalizeCourts, type Court } from "./courts";

// The queue: how queued matches reach the courts, and -- when the host has the
// Auto queue switched on -- how the app plans and refills the queue by itself.
//
// A match gets into the queue one of two ways: the host picks a suggestion or
// builds one by hand (worker/index.ts), or Auto queue plans it (syncAutoQueue
// below -- the rules it follows live in worker/lib/autoqueue.ts, which has no
// database code at all). Either way it waits in the same queue, and the first
// ones in line are put on whichever courts are open.

export const MAX_QUEUE_LENGTH = 8;

type SessionRow = typeof sessions.$inferSelect;
type PlayerRow = typeof players.$inferSelect;
type MatchRow = typeof matches.$inferSelect;

// The queue_position to give the next item appended to the end of the actual queue.
export async function nextQueuePosition(db: Db, sessionId: number): Promise<number> {
  const all = await db.select().from(matches).where(eq(matches.sessionId, sessionId));
  const positions = all.filter((m) => m.status === "queued").map((m) => m.queuePosition ?? 0);
  return positions.length ? Math.max(...positions) + 1 : 0;
}

// ---------------------------------------------------------------------------
// Database rows -> the plain shapes autoqueue.ts works with.
// ---------------------------------------------------------------------------

function toAutoPlayers(rows: PlayerRow[]): AutoPlayerInput[] {
  return rows.map((p) => ({
    id: p.id,
    level: p.level,
    approved: p.approved,
    status: p.status,
    preferredPartnerId: p.preferredPartnerId,
    currentStreak: p.currentStreak,
    pointsFor: p.pointsFor,
    pointsAgainst: p.pointsAgainst,
    gamesBaseline: p.gamesBaseline,
  }));
}

// Suggested matches are only ideas, not part of the session's play, so the
// planner never sees them.
function toAutoMatches(rows: MatchRow[]): AutoMatchInput[] {
  return rows
    .filter((m) => m.status === "completed" || m.status === "ongoing" || m.status === "queued")
    .map((m) => ({
      id: m.id,
      status: m.status,
      team1: m.team1 as number[],
      team2: m.team2 as number[],
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      queuePosition: m.queuePosition,
      auto: m.auto,
    }));
}

// ---------------------------------------------------------------------------
// Putting queued matches on open courts.
// ---------------------------------------------------------------------------

// Takes the rows already loaded for a session and puts queued matches on its open
// courts, front of the queue first. A queued match that can't go yet -- someone in
// it is still on another court, or is no longer approved and active -- is skipped
// and left in the queue, in place, rather than blocking everything behind it. With
// `enforceRest` on (Auto queue sessions), a match the app planned is also held
// back when it would give someone a third game in a row and there are enough
// rested players free to do better. Returns the rows with the started matches
// marked ongoing.
async function startQueuedMatches(
  db: Db,
  courts: Court[],
  playerRows: PlayerRow[],
  matchRows: MatchRow[],
  enforceRest: boolean,
): Promise<MatchRow[]> {
  let rows = matchRows;
  for (;;) {
    const ongoing = rows.filter((m) => m.status === "ongoing");
    const openCourts = courts.filter((court) => !isCourtOccupied(court, ongoing));
    if (openCourts.length === 0 || !rows.some((m) => m.status === "queued")) return rows;

    const { start } = selectMatchesToStart({
      players: toAutoPlayers(playerRows),
      matches: toAutoMatches(rows),
      openCourts: openCourts.length,
      enforceRest,
    });
    if (start.length === 0) return rows;

    const started = new Map<number, { courtId: string; courtLabel: string; startedAt: Date }>();
    for (let i = 0; i < start.length; i++) {
      const court = openCourts[i];
      const startedAt = new Date();
      await db
        .update(matches)
        .set({ status: "ongoing", courtId: court.id, courtLabel: court.label, startedAt })
        .where(eq(matches.id, start[i]));
      started.set(start[i], { courtId: court.id, courtLabel: court.label, startedAt });
    }
    rows = rows.map((m) => {
      const change = started.get(m.id);
      return change ? { ...m, ...change, status: "ongoing" } : m;
    });

    // Without the rest rule nothing new can become startable after a pass (a started
    // match only makes more players busy), so the single pass is exactly the old loop.
    // With it, starting a match also counts as "sat out" for everyone not in it, so a
    // match skipped a moment ago for needing a rest may be ready now: go round again
    // while courts are still open. Each pass starts at least one match, so this ends.
    if (!enforceRest) return rows;
  }
}

// Pull matches off the front of the actual queue onto any currently-open courts, in
// order, until either the queue or the open courts run out. A queued match whose
// players are no longer all active and free is skipped (left in the queue, in place)
// rather than blocking everything behind it -- the host will see it's stuck (it'll
// keep sitting at the front) and can remove or replace it. Safe to call any time;
// it's a no-op when there's nothing to do.
//
// With Auto queue ON for the session this also applies the rest rule (see
// startQueuedMatches). Pass `replan: true` from the places where something
// has just changed who is playing (a match finished or was removed from a court):
// for an Auto queue session that runs the full syncAutoQueue instead -- fill the
// courts, drop planned matches that stopped making sense, plan new ones, fill
// again. For a session with Auto queue off, `replan` does nothing: the queue is
// the host's alone, exactly as before.
export async function fillOpenCourtsFromQueue(db: Db, sessionId: number, opts: { replan?: boolean } = {}) {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session || session.status !== "active") return;

  if (opts.replan && session.autoQueue) {
    // The change that brought us here (a saved score, say) is already saved --
    // a problem in the Auto queue must never undo or block it.
    try {
      await runAutoQueue(db, session, {});
    } catch (err) {
      console.error("Auto queue error (non-fatal, the change itself was saved):", err);
    }
    return;
  }

  const allMatches = await db.select().from(matches).where(eq(matches.sessionId, sessionId));
  const courts = normalizeCourts(session.courtLabels);
  const ongoingMatches = allMatches.filter((m) => m.status === "ongoing");
  if (courts.every((court) => isCourtOccupied(court, ongoingMatches))) return;
  if (!allMatches.some((m) => m.status === "queued")) return;

  const sessionPlayers = await db.select().from(players).where(eq(players.sessionId, sessionId));
  await startQueuedMatches(db, courts, sessionPlayers, allMatches, session.autoQueue);
}

// ---------------------------------------------------------------------------
// Auto queue.
// ---------------------------------------------------------------------------

// Brings an Auto queue session up to date, in one pass over freshly loaded rows:
//   1. open courts take the first ready match in the queue;
//   2. planned (auto) matches that stopped making sense are dropped -- someone is
//      resting or gone, or would get a third game in a row -- and new ones are
//      planned to refill the queue (autoqueue.ts decides which, and in what order);
//   3. a court that is still open takes the first of the new matches.
// Matches the host picked or built by hand are never dropped or replaced.
// `rebuild` first discards every planned match still waiting, so the whole plan is
// made again from the current situation.
async function runAutoQueue(db: Db, session: SessionRow, opts: { rebuild?: boolean }) {
  const sessionId = session.id;
  const courts = normalizeCourts(session.courtLabels);
  const playerRows = await db.select().from(players).where(eq(players.sessionId, sessionId));
  let rows = await db.select().from(matches).where(eq(matches.sessionId, sessionId));

  rows = await startQueuedMatches(db, courts, playerRows, rows, true);

  const dropIds = new Set<number>();
  if (opts.rebuild) {
    for (const m of rows) if (m.status === "queued" && m.auto) dropIds.add(m.id);
  }
  const plan = planAutoQueue({
    players: toAutoPlayers(playerRows),
    matches: toAutoMatches(rows.filter((m) => !dropIds.has(m.id))),
    courtCount: courts.length || session.courtCount,
    now: Date.now(),
    maxQueueLength: MAX_QUEUE_LENGTH,
  });
  for (const id of plan.drop) dropIds.add(id);

  if (dropIds.size > 0) {
    await db.delete(matches).where(inArray(matches.id, [...dropIds]));
    rows = rows.filter((m) => !dropIds.has(m.id));
  }

  if (plan.add.length > 0) {
    // The database driver has no locking, so another request may have added
    // matches since we looked: count again right before inserting, and never go
    // past the queue limit.
    const waiting = await db
      .select({ id: matches.id, queuePosition: matches.queuePosition })
      .from(matches)
      .where(and(eq(matches.sessionId, sessionId), eq(matches.status, "queued")));
    const toAdd = plan.add.slice(0, Math.max(0, MAX_QUEUE_LENGTH - waiting.length));
    if (toAdd.length > 0) {
      const lastPosition = waiting.reduce((max, m) => Math.max(max, m.queuePosition ?? 0), -1);
      const inserted = await db
        .insert(matches)
        .values(
          toAdd.map((m, i) => ({
            sessionId,
            courtLabel: "",
            team1: m.team1,
            team2: m.team2,
            status: "queued",
            queuePosition: lastPosition + 1 + i,
            auto: true,
          })),
        )
        .returning();
      rows = rows.concat(inserted);

      // Same as when the host queues a match by hand: any suggestion that shares a
      // player with a match just planned is now out of date.
      const planned = new Set(toAdd.flatMap((m) => [...m.team1, ...m.team2]));
      const staleIds = rows
        .filter(
          (m) =>
            m.status === "suggested" &&
            [...(m.team1 as number[]), ...(m.team2 as number[])].some((pid) => planned.has(pid)),
        )
        .map((m) => m.id);
      if (staleIds.length > 0) {
        await db.delete(matches).where(inArray(matches.id, staleIds));
        rows = rows.filter((m) => !staleIds.includes(m.id));
      }
    }
  }

  await startQueuedMatches(db, courts, playerRows, rows, true);
}

// Runs the Auto queue for a session if it has it switched on (and is still
// active). Returns whether it ran. Errors are thrown -- use this where the host
// asked for exactly this (the Rebuild button); use syncAutoQueueQuietly after a
// change that has to succeed on its own.
export async function syncAutoQueue(db: Db, sessionId: number, opts: { rebuild?: boolean } = {}): Promise<boolean> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session || session.status !== "active" || !session.autoQueue) return false;
  await runAutoQueue(db, session, opts);
  return true;
}

// Same, for use right after a change that is already saved (a player's status, a
// court count...): a problem in the Auto queue is logged but never turns that
// change into an error.
export async function syncAutoQueueQuietly(db: Db, sessionId: number): Promise<void> {
  try {
    await syncAutoQueue(db, sessionId);
  } catch (err) {
    console.error("Auto queue error (non-fatal, the change itself was saved):", err);
  }
}
