import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import { matches, players } from "../../db/schema";

export interface OverallStats {
  sessionsPlayed: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  pointsFor: number;
  averageScore: number;
  highestScore: number;
}

// Totals across every session this account has a player row in -- guest rows
// (accountId null) never factor in here, since they're not linked to anyone.
export async function computeOverallStats(db: Db, accountId: number): Promise<OverallStats> {
  const myRows = await db.select().from(players).where(eq(players.accountId, accountId));

  const sessionsPlayed = myRows.length;
  const gamesPlayed = myRows.reduce((sum, p) => sum + p.gamesPlayed, 0);
  const wins = myRows.reduce((sum, p) => sum + p.wins, 0);
  const losses = myRows.reduce((sum, p) => sum + p.losses, 0);
  const pointsFor = myRows.reduce((sum, p) => sum + p.pointsFor, 0);
  const averageScore = gamesPlayed > 0 ? pointsFor / gamesPlayed : 0;

  let highestScore = 0;
  if (myRows.length > 0) {
    const sessionIds = [...new Set(myRows.map((p) => p.sessionId))];
    const myIdBySession = new Map(myRows.map((p) => [p.sessionId, p.id]));
    const allMatches = await db.select().from(matches).where(inArray(matches.sessionId, sessionIds));
    for (const m of allMatches) {
      if (m.status !== "completed") continue;
      const myId = myIdBySession.get(m.sessionId);
      if (myId == null) continue;
      const team1 = m.team1 as number[];
      const team2 = m.team2 as number[];
      if (team1.includes(myId)) highestScore = Math.max(highestScore, m.score1 ?? 0);
      else if (team2.includes(myId)) highestScore = Math.max(highestScore, m.score2 ?? 0);
    }
  }

  return { sessionsPlayed, gamesPlayed, wins, losses, pointsFor, averageScore, highestScore };
}
