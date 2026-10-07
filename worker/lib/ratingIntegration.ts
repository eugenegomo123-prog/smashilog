// Wires the pure rating engine (./rating.ts) into the database. Everything in
// rating.ts stays untouched and untouched-by-DB -- this file is the only place
// that reads/writes accounts.mmr / ratingDeviation / seasonPoints / etc. and the
// rating_history table.
//
// rateCompletedMatch is called from exactly one place: worker/index.ts's PATCH
// /api/matches/:id, and only the moment a match first becomes "completed"
// (never on a later score edit -- see AGENTS.md "Known simplifications" for
// why). Wrapped in a try/catch at that call site, so a bug here can never
// block a host from recording a score -- the original match/stats/queue flow
// keeps working even if rating updates fail for some reason.
//
// rollbackMatchRating is the delete-time counterpart, called from worker/
// index.ts's DELETE /api/matches/:id.
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import type { Db } from "../../db";
import { accounts, matches, players, ratingHistory } from "../../db/schema";
import {
  rateMatch,
  mmrToTier,
  GUEST_LEVEL_MMR,
  BASE_MMR,
  RD_START,
  PROVISIONAL_GAMES_THRESHOLD,
  growRatingDeviationForInactivity,
  type RatedPlayer,
  type MatchRatingResult,
  type PlayingMode,
} from "./rating";

const RECENT_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function rateCompletedMatch(db: Db, matchId: number): Promise<MatchRatingResult | null> {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
  if (!match || match.status !== "completed" || match.score1 == null || match.score2 == null) return null;

  const team1Ids = match.team1 as number[];
  const team2Ids = match.team2 as number[];
  const allIds = [...team1Ids, ...team2Ids];

  const rows = await db.select().from(players).where(inArray(players.id, allIds));
  const playerById = new Map(rows.map((p) => [p.id, p]));

  const accountIds = rows.filter((p) => p.accountId != null).map((p) => p.accountId as number);
  const accountRows = accountIds.length
    ? await db.select().from(accounts).where(inArray(accounts.id, accountIds))
    : [];
  const accountById = new Map(accountRows.map((a) => [a.id, a]));

  // Recent completed matches across ALL sessions, for the anti-farming repeat
  // check -- a small club app's whole match history is cheap to scan; no
  // per-session scoping here since the same two accounts could "farm" each
  // other across different sessions too.
  const now = new Date();
  const cutoff = new Date(now.getTime() - RECENT_WINDOW_DAYS * MS_PER_DAY);
  const allCompleted = await db.select().from(matches).where(eq(matches.status, "completed"));
  const recentCompleted = allCompleted.filter(
    (m) => m.id !== matchId && m.endedAt && new Date(m.endedAt as unknown as string) >= cutoff,
  );

  const recentPlayerIds = new Set<number>();
  for (const m of recentCompleted) {
    for (const pid of m.team1 as number[]) recentPlayerIds.add(pid);
    for (const pid of m.team2 as number[]) recentPlayerIds.add(pid);
  }
  const recentPlayerRows = recentPlayerIds.size
    ? await db.select().from(players).where(inArray(players.id, [...recentPlayerIds]))
    : [];
  const accountIdByPlayerId = new Map(
    recentPlayerRows.filter((p) => p.accountId != null).map((p) => [p.id, p.accountId as number]),
  );

  // How many times `accountId` shared a team (sameTeam=true) or faced
  // (sameTeam=false) any account in `otherAccountIds`, in the recent window.
  function countMeetings(accountId: number, otherAccountIds: Set<number>, sameTeam: boolean): number {
    if (otherAccountIds.size === 0) return 0;
    let count = 0;
    for (const m of recentCompleted) {
      const t1 = (m.team1 as number[]).map((pid) => accountIdByPlayerId.get(pid) ?? null);
      const t2 = (m.team2 as number[]).map((pid) => accountIdByPlayerId.get(pid) ?? null);
      const onT1 = t1.includes(accountId);
      const onT2 = t2.includes(accountId);
      if (!onT1 && !onT2) continue;
      const relevant = sameTeam ? (onT1 ? t1 : t2) : onT1 ? t2 : t1;
      if (relevant.some((id) => id != null && otherAccountIds.has(id))) count++;
    }
    return count;
  }

  function toRatedPlayer(playerId: number, teammateId: number, opponentIds: number[]): RatedPlayer {
    const p = playerById.get(playerId)!;
    const account = p.accountId != null ? accountById.get(p.accountId) : undefined;
    const effectiveMmr = account ? account.mmr : (GUEST_LEVEL_MMR[p.level] ?? BASE_MMR);

    let ratingDeviation = account ? account.ratingDeviation : RD_START;
    if (account?.lastRatedMatchAt) {
      const days = (now.getTime() - new Date(account.lastRatedMatchAt as unknown as string).getTime()) / MS_PER_DAY;
      ratingDeviation = growRatingDeviationForInactivity(ratingDeviation, Math.max(0, days));
    }

    const teammateAccountId = playerById.get(teammateId)?.accountId ?? null;
    const opponentAccountIds = new Set(
      opponentIds
        .map((id) => playerById.get(id)?.accountId)
        .filter((id): id is number => id != null),
    );

    return {
      accountId: p.accountId,
      effectiveMmr,
      ratingDeviation,
      ratedGamesPlayed: account?.ratedGamesPlayed ?? 0,
      seasonPoints: account?.seasonPoints ?? 0,
      currentStreak: account?.currentRatingStreak ?? 0,
      playingMode: (p.playingMode === "chill" ? "chill" : "competitive") as PlayingMode,
      recentMeetingsWithOpponents: p.accountId != null ? countMeetings(p.accountId, opponentAccountIds, false) : 0,
      recentMatchesWithTeammate:
        p.accountId != null && teammateAccountId != null
          ? countMeetings(p.accountId, new Set([teammateAccountId]), true)
          : 0,
    };
  }

  const [t1a, t1b] = team1Ids;
  const [t2a, t2b] = team2Ids;
  const result = rateMatch({
    team1: [toRatedPlayer(t1a, t1b, team2Ids), toRatedPlayer(t1b, t1a, team2Ids)],
    team2: [toRatedPlayer(t2a, t2b, team1Ids), toRatedPlayer(t2b, t2a, team1Ids)],
    score1: match.score1,
    score2: match.score2,
  });

  if (!result.rated) return result;

  for (const r of result.results) {
    const account = accountById.get(r.accountId);
    if (!account) continue;
    const newStreak = r.won ? Math.max(1, account.currentRatingStreak + 1) : 0;

    await db
      .update(accounts)
      .set({
        mmr: r.newMmr,
        ratingDeviation: r.newRatingDeviation,
        ratedGamesPlayed: account.ratedGamesPlayed + 1,
        seasonPoints: r.newSeasonPoints,
        currentRatingStreak: newStreak,
        lastRatedMatchAt: now,
      })
      .where(eq(accounts.id, r.accountId));

    await db.insert(ratingHistory).values({
      accountId: r.accountId,
      matchId,
      previousMmr: r.previousMmr,
      newMmr: r.newMmr,
      mmrChange: r.mmrChange,
      previousRatingDeviation: r.previousRatingDeviation,
      newRatingDeviation: r.newRatingDeviation,
      previousSeasonPoints: r.previousSeasonPoints,
      newSeasonPoints: r.newSeasonPoints,
      seasonPointsChange: r.seasonPointsChange,
      won: r.won,
    });
  }

  return result;
}

export interface RatingRollbackResult {
  // Usernames whose rating was restored to what it was right before this match.
  rolledBack: string[];
  // Usernames whose rating was deliberately left untouched, with a plain-language reason.
  skipped: { username: string; reason: string }[];
}

// Delete-time counterpart to rateCompletedMatch above: undoes this match's
// effect on every registered account it rated, then clears its rating_history
// rows (which is also what lets the match itself be deleted -- matches.id is
// a foreign key target of rating_history.matchId, so a rated match can't be
// removed while those rows still point at it).
//
// mmr/ratingDeviation/seasonPoints/ratedGamesPlayed can always be restored
// exactly, because rateCompletedMatch already snapshotted each account's
// "previous" values onto its own rating_history row when the match was rated
// -- no replay needed for those.
//
// currentRatingStreak is the one field that row doesn't snapshot directly,
// but it doesn't need to be: it only ever depends on the account's own
// sequence of win/loss outcomes (see the `newStreak = won ? max(1,
// streak+1) : 0` rule below, identical to the one in rateCompletedMatch
// above), and that sequence is exactly what each remaining rating_history
// row's `won` column already records. So it's recomputed by replaying that
// sequence for just this one account, not by touching anyone else's numbers.
//
// The one thing this deliberately does NOT attempt: rolling back a match that
// ISN'T the account's most recent rated game. That would also require
// undoing and redoing every rated match that account played after this one
// (their mmr going into each of those depended on the mmr this match
// produced), which can cascade into their opponents' and teammates' numbers
// in those later matches too -- a full historical replay, not a rollback.
// Safer to leave that account's current rating exactly as-is (still correct
// for everything that's happened since) and say so plainly, than to "fix"
// one match by quietly corrupting the ones after it.
export async function rollbackMatchRating(db: Db, matchId: number): Promise<RatingRollbackResult> {
  const rows = await db.select().from(ratingHistory).where(eq(ratingHistory.matchId, matchId));
  const result: RatingRollbackResult = { rolledBack: [], skipped: [] };
  if (rows.length === 0) return result;

  for (const row of rows) {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, row.accountId));
    if (!account) continue; // the account itself is gone -- nothing left to roll back

    const laterRows = await db
      .select()
      .from(ratingHistory)
      .where(and(eq(ratingHistory.accountId, row.accountId), gt(ratingHistory.id, row.id)));
    if (laterRows.length > 0) {
      result.skipped.push({ username: account.username, reason: "played a newer rated match since" });
      continue;
    }

    const remaining = await db
      .select()
      .from(ratingHistory)
      .where(and(eq(ratingHistory.accountId, row.accountId), ne(ratingHistory.id, row.id)))
      .orderBy(asc(ratingHistory.id));
    let streak = 0;
    for (const r of remaining) {
      streak = r.won ? Math.max(1, streak + 1) : 0;
    }
    const lastRemaining = remaining[remaining.length - 1];
    let lastRemainingEndedAt: Date | null = null;
    if (lastRemaining) {
      const [lastMatch] = await db.select().from(matches).where(eq(matches.id, lastRemaining.matchId));
      lastRemainingEndedAt = (lastMatch?.endedAt as unknown as Date | null) ?? null;
    }

    await db
      .update(accounts)
      .set({
        mmr: row.previousMmr,
        ratingDeviation: row.previousRatingDeviation,
        seasonPoints: row.previousSeasonPoints,
        ratedGamesPlayed: Math.max(0, account.ratedGamesPlayed - 1),
        currentRatingStreak: streak,
        lastRatedMatchAt: lastRemainingEndedAt,
      })
      .where(eq(accounts.id, row.accountId));

    result.rolledBack.push(account.username);
  }

  await db.delete(ratingHistory).where(eq(ratingHistory.matchId, matchId));
  return result;
}

// Used by GET /api/me/rating -- the player-facing view. Never exposes raw
// mmr/ratingDeviation, per the design doc's "hidden MMR, visible tier" rule.
export function publicRatingView(account: {
  mmr: number;
  ratingDeviation: number;
  ratedGamesPlayed: number;
  seasonPoints: number;
  currentRatingStreak: number;
}) {
  const tierInfo = mmrToTier(account.mmr, account.ratedGamesPlayed, account.ratingDeviation);
  return {
    tier: tierInfo.tier,
    division: tierInfo.division,
    provisional: tierInfo.provisional,
    seasonPoints: account.seasonPoints,
    ratedGamesPlayed: account.ratedGamesPlayed,
    currentRatingStreak: account.currentRatingStreak,
    // Sent so the client can render "X of Y rated games played" without
    // hardcoding the threshold a second time -- see rating.ts.
    provisionalGamesThreshold: PROVISIONAL_GAMES_THRESHOLD,
  };
}
