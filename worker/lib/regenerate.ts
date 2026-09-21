import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { matches, players, sessions } from "../../db/schema";
import { bestSplit, sortByPriority, type PlayerForMatchmaking } from "./matchmaking";
import { playerIdsInOngoingMatches } from "./stats";

// Fill every open court in a session with a new match, pulling from the eligible pool
// (active players, not currently in an ongoing match) in priority order.
export async function regenerateQueue(db: Db, sessionId: number) {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session || session.status !== "active") return;

  const allPlayers = await db.select().from(players).where(eq(players.sessionId, sessionId));
  const busy = await playerIdsInOngoingMatches(db, sessionId);
  const ongoing = await db.select().from(matches).where(eq(matches.sessionId, sessionId));

  const courtLabels = (session.courtLabels as string[]) ?? [];
  const occupiedLabels = new Set(
    ongoing.filter((m) => m.status === "ongoing").map((m) => m.courtLabel),
  );
  const openCourts = courtLabels.filter((label) => !occupiedLabels.has(label));

  let pool: PlayerForMatchmaking[] = sortByPriority(
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

  for (const courtLabel of openCourts) {
    if (pool.length < 4) break;
    const four = pool.slice(0, 4);
    pool = pool.slice(4);
    const split = bestSplit(four);
    await db.insert(matches).values({
      sessionId,
      courtLabel,
      team1: [split.team1[0].id, split.team1[1].id],
      team2: [split.team2[0].id, split.team2[1].id],
      status: "ongoing",
    });
  }
}
