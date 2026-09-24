import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { matches, players } from "../../db/schema";

// Recompute every player's derived stats (wins, losses, points, streak, games played,
// lastMatchEndedAt) from the full completed-match history for a session. Recomputing from
// scratch (rather than patching deltas) keeps score edits correct with no separate undo logic.
interface PlayerStatAccumulator {
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  currentStreak: number;
  gamesPlayed: number;
  lastMatchEndedAt: string | null;
}

export async function recomputeSessionStats(db: Db, sessionId: number) {
  const sessionPlayers = await db.select().from(players).where(eq(players.sessionId, sessionId));
  const byId = new Map<number, PlayerStatAccumulator>(
    sessionPlayers.map((p) => [
      p.id,
      {
        wins: 0,
        losses: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        currentStreak: 0,
        gamesPlayed: 0,
        lastMatchEndedAt: null,
      },
    ]),
  );

  const completed = await db
    .select()
    .from(matches)
    .where(eq(matches.sessionId, sessionId));

  const finished = completed
    .filter((m) => m.status === "completed" && m.endedAt)
    .sort((a, b) => new Date(a.endedAt as unknown as string).getTime() - new Date(b.endedAt as unknown as string).getTime());

  for (const m of finished) {
    const team1 = m.team1 as number[];
    const team2 = m.team2 as number[];
    const s1 = m.score1 ?? 0;
    const s2 = m.score2 ?? 0;
    const team1Won = s1 > s2;
    for (const pid of team1) {
      const stat = byId.get(pid);
      if (!stat) continue;
      stat.gamesPlayed += 1;
      stat.pointsFor += s1;
      stat.pointsAgainst += s2;
      stat.currentStreak = team1Won ? Math.max(1, stat.currentStreak + 1) : Math.min(-1, stat.currentStreak - 1);
      if (team1Won) stat.wins += 1; else stat.losses += 1;
      stat.lastMatchEndedAt = m.endedAt as unknown as string;
    }
    for (const pid of team2) {
      const stat = byId.get(pid);
      if (!stat) continue;
      stat.gamesPlayed += 1;
      stat.pointsFor += s2;
      stat.pointsAgainst += s1;
      stat.currentStreak = !team1Won ? Math.max(1, stat.currentStreak + 1) : Math.min(-1, stat.currentStreak - 1);
      if (!team1Won) stat.wins += 1; else stat.losses += 1;
      stat.lastMatchEndedAt = m.endedAt as unknown as string;
    }
  }

  for (const [id, stat] of byId.entries()) {
    await db.update(players).set({
      wins: stat.wins,
      losses: stat.losses,
      pointsFor: stat.pointsFor,
      pointsAgainst: stat.pointsAgainst,
      currentStreak: stat.currentStreak,
      gamesPlayed: stat.gamesPlayed,
      lastMatchEndedAt: stat.lastMatchEndedAt ? new Date(stat.lastMatchEndedAt) : null,
    }).where(eq(players.id, id));
  }
}

// A player counts as unavailable for new suggestions/custom matches/queue entries if
// they're either actually on a court right now, or already lined up in the actual
// queue -- either way they shouldn't be double-booked into something else.
export async function playerIdsUnavailable(db: Db, sessionId: number): Promise<Set<number>> {
  const all = await db.select().from(matches).where(eq(matches.sessionId, sessionId));
  const busy = new Set<number>();
  for (const m of all) {
    if (m.status !== "ongoing" && m.status !== "queued") continue;
    for (const pid of m.team1 as number[]) busy.add(pid);
    for (const pid of m.team2 as number[]) busy.add(pid);
  }
  return busy;
}
