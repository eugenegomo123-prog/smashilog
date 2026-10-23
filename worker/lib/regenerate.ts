import { and, eq } from "drizzle-orm";
import type { Db } from "../../db";
import { matches, players, sessions } from "../../db/schema";
import { generateSuggestedMatches, type PairHistory, type PlayerForMatchmaking } from "./matchmaking";
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

function bumpCount(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function pairKeyOfIds(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function groupKeyOfIds(ids: number[]): string {
  return [...ids].sort((x, y) => x - y).join(",");
}

// Builds everything the matchmaking module's fairness/variety tiers need from
// the session's completed-match history: how many times each pair has
// partnered/opposed each other, each player's single most-recent
// partner/opponent (a stronger nudge than the plain counts -- see
// matchmaking.ts), how many times each exact 4-player group has played
// together, and who was in the single most-recently-completed match ("just
// played"). All derived from existing completed `matches` rows -- nothing new
// is stored to produce this (see the project's matchmaking design brief,
// section 8: "never fabricate missing history... use existing fields and
// records whenever possible").
export function buildPairHistory(allMatches: (typeof matches.$inferSelect)[]): PairHistory {
  const completed = allMatches
    .filter((m) => m.status === "completed" && m.endedAt)
    .sort(
      (a, b) =>
        new Date(b.endedAt as unknown as string).getTime() - new Date(a.endedAt as unknown as string).getTime(),
    );

  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const lastPartnerOf = new Map<number, number>();
  const lastOpponentOf = new Map<number, number>();
  const groupCounts = new Map<string, number>();

  for (const m of completed) {
    const team1 = m.team1 as number[];
    const team2 = m.team2 as number[];

    if (team1.length === 2) {
      bumpCount(partnerCounts, pairKeyOfIds(team1[0], team1[1]));
      if (!lastPartnerOf.has(team1[0])) lastPartnerOf.set(team1[0], team1[1]);
      if (!lastPartnerOf.has(team1[1])) lastPartnerOf.set(team1[1], team1[0]);
    }
    if (team2.length === 2) {
      bumpCount(partnerCounts, pairKeyOfIds(team2[0], team2[1]));
      if (!lastPartnerOf.has(team2[0])) lastPartnerOf.set(team2[0], team2[1]);
      if (!lastPartnerOf.has(team2[1])) lastPartnerOf.set(team2[1], team2[0]);
    }

    if (team1.length === 2 && team2.length === 2) {
      for (const a of team1) {
        for (const b of team2) {
          bumpCount(opponentCounts, pairKeyOfIds(a, b));
        }
      }
      for (const pid of team1) if (!lastOpponentOf.has(pid)) lastOpponentOf.set(pid, team2[0]);
      for (const pid of team2) if (!lastOpponentOf.has(pid)) lastOpponentOf.set(pid, team1[0]);

      bumpCount(groupCounts, groupKeyOfIds([...team1, ...team2]));
    }
  }

  const justPlayedIds = new Set<number>();
  if (completed.length > 0) {
    const mostRecent = completed[0];
    for (const pid of mostRecent.team1 as number[]) justPlayedIds.add(pid);
    for (const pid of mostRecent.team2 as number[]) justPlayedIds.add(pid);
  }

  return { partnerCounts, opponentCounts, lastPartnerOf, lastOpponentOf, groupCounts, justPlayedIds };
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

  const history = buildPairHistory(allMatches);
  const suggestions = generateSuggestedMatches(eligible, history, SUGGESTIONS_PER_REGENERATE, session.courtCount, Date.now());

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
