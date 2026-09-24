import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { matches, players, sessions } from "../../db/schema";

export const MAX_QUEUE_LENGTH = 8;

// The queue_position to give the next item appended to the end of the actual queue.
export async function nextQueuePosition(db: Db, sessionId: number): Promise<number> {
  const all = await db.select().from(matches).where(eq(matches.sessionId, sessionId));
  const positions = all.filter((m) => m.status === "queued").map((m) => m.queuePosition ?? 0);
  return positions.length ? Math.max(...positions) + 1 : 0;
}

// Pull matches off the front of the actual queue onto any currently-open courts, in
// order, until either the queue or the open courts run out. A queued match whose
// players are no longer all active and free is skipped (left in the queue, in place)
// rather than blocking everything behind it -- the host will see it's stuck (it'll
// keep sitting at the front) and can remove or replace it. Safe to call any time;
// it's a no-op when there's nothing to do.
export async function fillOpenCourtsFromQueue(db: Db, sessionId: number) {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session || session.status !== "active") return;

  const allMatches = await db.select().from(matches).where(eq(matches.sessionId, sessionId));
  const occupiedLabels = new Set(allMatches.filter((m) => m.status === "ongoing").map((m) => m.courtLabel));
  const openCourts = (session.courtLabels as string[]).filter((label) => !occupiedLabels.has(label));
  if (openCourts.length === 0) return;

  const queued = allMatches
    .filter((m) => m.status === "queued")
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  if (queued.length === 0) return;

  const sessionPlayers = await db.select().from(players).where(eq(players.sessionId, sessionId));
  const playerMap = new Map(sessionPlayers.map((p) => [p.id, p]));
  const busy = new Set<number>();
  for (const m of allMatches) {
    if (m.status !== "ongoing") continue;
    for (const pid of m.team1 as number[]) busy.add(pid);
    for (const pid of m.team2 as number[]) busy.add(pid);
  }

  let courtIndex = 0;
  for (const match of queued) {
    if (courtIndex >= openCourts.length) break;
    const ids = [...(match.team1 as number[]), ...(match.team2 as number[])];
    const stillValid = ids.every((pid) => {
      const p = playerMap.get(pid);
      return !!p && p.approved && p.status === "active" && !busy.has(pid);
    });
    if (!stillValid) continue;

    const court = openCourts[courtIndex];
    await db
      .update(matches)
      .set({ status: "ongoing", courtLabel: court, startedAt: new Date() })
      .where(eq(matches.id, match.id));
    for (const pid of ids) busy.add(pid);
    courtIndex++;
  }
}
