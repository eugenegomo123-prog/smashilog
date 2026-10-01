import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import { accounts, matches, players } from "../../db/schema";

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

export interface AccountRankEntry {
  accountId: number;
  username: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
}

// All-time: sum each account's already-stored per-session totals -- fast, and
// consistent with what Overall Stats already shows.
export async function computeAllTimeRanking(db: Db): Promise<AccountRankEntry[]> {
  const allAccounts = await db.select().from(accounts);
  const allPlayers = await db.select().from(players);

  const byAccount = new Map<number, AccountRankEntry>(
    allAccounts.map((a) => [
      a.id,
      { accountId: a.id, username: a.username, gamesPlayed: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 },
    ]),
  );

  for (const p of allPlayers) {
    if (p.accountId == null) continue;
    const entry = byAccount.get(p.accountId);
    if (!entry) continue;
    entry.gamesPlayed += p.gamesPlayed;
    entry.wins += p.wins;
    entry.losses += p.losses;
    entry.pointsFor += p.pointsFor;
    entry.pointsAgainst += p.pointsAgainst;
  }

  return [...byAccount.values()].filter((e) => e.gamesPlayed > 0);
}

// A specific month ("YYYY-MM"): per-session totals don't break down by month, so
// this recomputes directly from completed matches that ended within that month.
export async function computeMonthRanking(db: Db, month: string): Promise<AccountRankEntry[]> {
  const [yearStr, monthStr] = month.split("-");
  const start = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, 1));
  const end = new Date(Date.UTC(Number(yearStr), Number(monthStr), 1));

  const allAccounts = await db.select().from(accounts);
  const allPlayers = await db.select().from(players);
  const usernameById = new Map(allAccounts.map((a) => [a.id, a.username]));
  const accountIdByPlayerId = new Map(
    allPlayers.filter((p) => p.accountId != null).map((p) => [p.id, p.accountId as number]),
  );

  const allMatches = await db.select().from(matches);
  const byAccount = new Map<number, AccountRankEntry>();

  function entryFor(accountId: number): AccountRankEntry {
    let e = byAccount.get(accountId);
    if (!e) {
      e = { accountId, username: usernameById.get(accountId) ?? "?", gamesPlayed: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 };
      byAccount.set(accountId, e);
    }
    return e;
  }

  for (const m of allMatches) {
    if (m.status !== "completed" || !m.endedAt) continue;
    const endedAt = new Date(m.endedAt as unknown as string);
    if (endedAt < start || endedAt >= end) continue;

    const team1 = m.team1 as number[];
    const team2 = m.team2 as number[];
    const s1 = m.score1 ?? 0;
    const s2 = m.score2 ?? 0;
    const team1Won = s1 > s2;

    for (const pid of team1) {
      const accountId = accountIdByPlayerId.get(pid);
      if (accountId == null) continue;
      const e = entryFor(accountId);
      e.gamesPlayed += 1;
      e.pointsFor += s1;
      e.pointsAgainst += s2;
      team1Won ? (e.wins += 1) : (e.losses += 1);
    }
    for (const pid of team2) {
      const accountId = accountIdByPlayerId.get(pid);
      if (accountId == null) continue;
      const e = entryFor(accountId);
      e.gamesPlayed += 1;
      e.pointsFor += s2;
      e.pointsAgainst += s1;
      !team1Won ? (e.wins += 1) : (e.losses += 1);
    }
  }

  return [...byAccount.values()];
}

// Same ranking rules as the per-session tables (win% -> wins -> fewest losses ->
// avg point diff), minus the skill-level tiebreaker, since level is per-session
// and an account may have played at different levels across sessions.
export function rankAccounts(entries: AccountRankEntry[]): AccountRankEntry[] {
  return [...entries].sort((a, b) => {
    const wpA = a.gamesPlayed ? a.wins / a.gamesPlayed : 0;
    const wpB = b.gamesPlayed ? b.wins / b.gamesPlayed : 0;
    if (wpB !== wpA) return wpB - wpA;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.losses !== b.losses) return a.losses - b.losses;
    const diffA = a.gamesPlayed ? (a.pointsFor - a.pointsAgainst) / a.gamesPlayed : 0;
    const diffB = b.gamesPlayed ? (b.pointsFor - b.pointsAgainst) / b.gamesPlayed : 0;
    if (diffB !== diffA) return diffB - diffA;
    return a.username.localeCompare(b.username);
  });
}
