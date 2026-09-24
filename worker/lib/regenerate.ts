import { and, eq } from "drizzle-orm";
import type { Db } from "../../db";
import { matches, players, sessions } from "../../db/schema";
import { generateSuggestedMatches, type PlayerForMatchmaking } from "./matchmaking";
import { playerIdsUnavailable } from "./stats";

const SUGGESTIONS_PER_REGENERATE = 8;

function toMatchmakingPlayer(p: typeof players.$inferSelect): PlayerForMatchmaking {
  return {
    id: p.id,
    level: p.level,
    currentStreak: p.currentStreak,
    pointsFor: p.pointsFor,
    pointsAgainst: p.pointsAgainst,
    gamesPlayed: p.gamesPlayed,
    lastMatchEndedAt: p.lastMatchEndedAt ? (p.lastMatchEndedAt as unknown as Date).toISOString() : null,
    preferredPartnerId: p.preferredPartnerId ?? null,
  };
}

// Each player's teammate from their most recently completed match, if any -- used
// to nudge new suggestions away from immediately repeating the same partnership.
function buildLastPartnerMap(allMatches: (typeof matches.$inferSelect)[]): Map<number, number> {
  const completed = allMatches
    .filter((m) => m.status === "completed" && m.endedAt)
    .sort(
      (a, b) =>
        new Date(b.endedAt as unknown as string).getTime() - new Date(a.endedAt as unknown as string).getTime(),
    );
  const map = new Map<number, number>();
  for (const m of completed) {
    const team1 = m.team1 as number[];
    const team2 = m.team2 as number[];
    if (team1.length === 2) {
      if (!map.has(team1[0])) map.set(team1[0], team1[1]);
      if (!map.has(team1[1])) map.set(team1[1], team1[0]);
    }
    if (team2.length === 2) {
      if (!map.has(team2[0])) map.set(team2[0], team2[1]);
      if (!map.has(team2[1])) map.set(team2[1], team2[0]);
    }
  }
  return map;
}

// Replace the session's suggested matches with a fresh batch computed from whoever
// is currently eligible: approved, status "active", and not already on a court or
// already sitting in the actual queue. Never touches ongoing/queued/completed matches
// -- only the suggestion pool. Safe to call at any time.
export async function regenerateQueue(db: Db, sessionId: number) {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session || session.status !== "active") return;

  const allPlayers = await db.select().from(players).where(eq(players.sessionId, sessionId));
  const allMatches = await db.select().from(matches).where(eq(matches.sessionId, sessionId));
  const unavailable = await playerIdsUnavailable(db, sessionId);

  const eligible: PlayerForMatchmaking[] = allPlayers
    .filter((p) => p.approved && p.status === "active" && !unavailable.has(p.id))
    .map(toMatchmakingPlayer);

  const lastPartnerOf = buildLastPartnerMap(allMatches);
  const suggestions = generateSuggestedMatches(eligible, lastPartnerOf, SUGGESTIONS_PER_REGENERATE);

  await db.delete(matches).where(and(eq(matches.sessionId, sessionId), eq(matches.status, "suggested")));

  for (const s of suggestions) {
    await db.insert(matches).values({
      sessionId,
      courtLabel: "",
      team1: [s.team1[0].id, s.team1[1].id],
      team2: [s.team2[0].id, s.team2[1].id],
      status: "suggested",
    });
  }
}
