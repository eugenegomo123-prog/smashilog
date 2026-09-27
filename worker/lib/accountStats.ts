import { eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../../db";
import { accounts, matches, players, sessions } from "../../db/schema";

export interface OverallStats {
  sessionsPlayed: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  totalPoints: number;
  averageScore: number;
  highestScore: number;
}

// Roll up every session-scoped `players` row linked to this account into one lifetime
// total. Deliberately re-derives from the per-session rows every time (same philosophy
// as recomputeSessionStats in stats.ts) rather than keeping a separate running total,
// so it can never drift from the per-session numbers those rows already hold.
export async function computeOverallStats(db: Db, accountId: number): Promise<OverallStats> {
  const rows = await db.select().from(players).where(eq(players.accountId, accountId));

  const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
  const wins = rows.reduce((sum, r) => sum + r.wins, 0);
  const losses = rows.reduce((sum, r) => sum + r.losses, 0);
  const gamesPlayed = rows.reduce((sum, r) => sum + r.gamesPlayed, 0);
  const totalPoints = rows.reduce((sum, r) => sum + r.pointsFor, 0);

  // Highest single-match score: scan completed matches in every session this account
  // played in, and check whichever side each of its player-rows was on.
  let highestScore = 0;
  if (sessionIds.length > 0) {
    const allMatches = await db.select().from(matches).where(inArray(matches.sessionId, sessionIds));
    const myPlayerIds = new Set(rows.map((r) => r.id));
    for (const m of allMatches) {
      if (m.status !== "completed") continue;
      const team1 = m.team1 as number[];
      const team2 = m.team2 as number[];
      if (team1.some((id) => myPlayerIds.has(id))) highestScore = Math.max(highestScore, m.score1 ?? 0);
      if (team2.some((id) => myPlayerIds.has(id))) highestScore = Math.max(highestScore, m.score2 ?? 0);
    }
  }

  return {
    sessionsPlayed: sessionIds.length,
    gamesPlayed,
    wins,
    losses,
    totalPoints,
    averageScore: gamesPlayed > 0 ? Math.round((totalPoints / gamesPlayed) * 10) / 10 : 0,
    highestScore,
  };
}

export interface HistoryEntry {
  sessionId: number;
  sessionName: string;
  sessionStatus: string;
  date: string;
  playerId: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  totalPoints: number;
}

export async function computeHistory(db: Db, accountId: number): Promise<HistoryEntry[]> {
  const rows = await db.select().from(players).where(eq(players.accountId, accountId));
  if (rows.length === 0) return [];
  const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
  const allSessions = await db.select().from(sessions).where(inArray(sessions.id, sessionIds));
  const sessionById = new Map(allSessions.map((s) => [s.id, s]));

  return rows
    .map((r) => {
      const s = sessionById.get(r.sessionId);
      return {
        sessionId: r.sessionId,
        sessionName: s?.name ?? "Unknown session",
        sessionStatus: s?.status ?? "ended",
        date: (s?.endedAt ?? s?.createdAt ?? r.createdAt) as unknown as string,
        playerId: r.id,
        gamesPlayed: r.gamesPlayed,
        wins: r.wins,
        losses: r.losses,
        totalPoints: r.pointsFor,
      };
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export interface RankingEntry {
  accountId: number;
  name: string;
  wins: number;
  losses: number;
  gamesPlayed: number;
  totalPoints: number;
  winPct: number;
}

// period is "all" or a "YYYY-MM" string. Monthly ranking groups by the session's
// createdAt month (sessions are effectively single-day events in this app).
export async function computeRanking(db: Db, period: string): Promise<RankingEntry[]> {
  const rows = await db.select().from(players).where(isNotNull(players.accountId));
  if (rows.length === 0) return [];

  let filteredRows = rows;
  if (period !== "all") {
    const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
    const allSessions = await db.select().from(sessions).where(inArray(sessions.id, sessionIds));
    const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const sessionMonth = new Map(allSessions.map((s) => [s.id, monthOf(new Date(s.createdAt as unknown as string))]));
    filteredRows = rows.filter((r) => sessionMonth.get(r.sessionId) === period);
  }

  const byAccount = new Map<number, { wins: number; losses: number; gamesPlayed: number; totalPoints: number }>();
  for (const r of filteredRows) {
    const accId = r.accountId as number;
    const acc = byAccount.get(accId) ?? { wins: 0, losses: 0, gamesPlayed: 0, totalPoints: 0 };
    acc.wins += r.wins;
    acc.losses += r.losses;
    acc.gamesPlayed += r.gamesPlayed;
    acc.totalPoints += r.pointsFor;
    byAccount.set(accId, acc);
  }

  const accountIds = [...byAccount.keys()];
  const accountRows =
    accountIds.length > 0 ? await db.select().from(accounts).where(inArray(accounts.id, accountIds)) : [];
  const nameById = new Map(accountRows.map((a) => [a.id, a.name]));

  const entries: RankingEntry[] = accountIds.map((id) => {
    const acc = byAccount.get(id)!;
    return {
      accountId: id,
      name: nameById.get(id) ?? "Unknown",
      wins: acc.wins,
      losses: acc.losses,
      gamesPlayed: acc.gamesPlayed,
      totalPoints: acc.totalPoints,
      winPct: acc.gamesPlayed > 0 ? acc.wins / acc.gamesPlayed : 0,
    };
  });

  entries.sort((a, b) => b.winPct - a.winPct || b.gamesPlayed - a.gamesPlayed);
  return entries;
}

// Distinct "YYYY-MM" months that have at least one session, newest first -- used to
// populate the ranking period dropdown.
export async function listRankingMonths(db: Db): Promise<string[]> {
  const allSessions = await db.select().from(sessions);
  const months = new Set<string>();
  for (const s of allSessions) {
    const d = new Date(s.createdAt as unknown as string);
    months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return [...months].sort().reverse();
}
