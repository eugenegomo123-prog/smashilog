// Badminton MMR / rating engine.
//
// IMPORTANT: this file is a standalone addition. Nothing in the existing app
// imports it yet, and it does not modify, depend on, or interfere with
// matchmaking.ts, stats.ts, or anything else already in worker/lib/. It is
// pure and deterministic (no I/O, no Date.now() inside the core math) so the
// same inputs always produce the same outputs -- safe to unit test and safe
// to review before it's ever wired into the live match-completion flow.
//
// See docs/rating-system-design.md for the full reasoning behind every
// formula and constant below.

export type PlayingMode = "competitive" | "chill";

// A player's rating state going into one match. For a guest (accountId null),
// `effectiveMmr` should already be set by the caller from GUEST_LEVEL_MMR --
// this module doesn't know or care whether a number came from a real account
// or a level-based estimate; it only treats accountId as "do we write a
// result back for this person."
export interface RatedPlayer {
  accountId: number | null;
  effectiveMmr: number;
  ratingDeviation: number;
  ratedGamesPlayed: number;
  seasonPoints: number;
  currentStreak: number;
  playingMode: PlayingMode;
  /** How many times this account has faced any of today's opponents recently (e.g. last 7 days). Omit or 0 if unknown. */
  recentMeetingsWithOpponents?: number;
  /** How many times this account has partnered with today's teammate recently. Omit or 0 if unknown. */
  recentMatchesWithTeammate?: number;
}

export interface MatchRatingInput {
  team1: [RatedPlayer, RatedPlayer];
  team2: [RatedPlayer, RatedPlayer];
  score1: number;
  score2: number;
}

export interface PlayerRatingResult {
  accountId: number;
  previousMmr: number;
  newMmr: number;
  mmrChange: number;
  previousRatingDeviation: number;
  newRatingDeviation: number;
  previousSeasonPoints: number;
  newSeasonPoints: number;
  seasonPointsChange: number;
  expectedWinProbability: number;
  kFactor: number;
  marginMultiplier: number;
  antiFarmingMultiplier: number;
  opponentAvgMmr: number;
  teammateMmr: number;
  won: boolean;
}

export interface MatchRatingResult {
  rated: boolean;
  reason?: string;
  results: PlayerRatingResult[]; // one entry per player with an accountId; guests are skipped
}

// ---- Tunable constants (see design doc section 3 for the reasoning) ----

export const BASE_MMR = 1000;
export const RD_START = 350;
export const RD_FLOOR = 50;
export const RD_MAX = 350;
export const RD_MATCH_DECAY = 0.92; // multiplicative shrink per rated match
export const RD_INACTIVITY_PERIOD_DAYS = 30;
export const RD_INACTIVITY_C = 30; // Glicko-style growth constant per period

export const K_BASE = 24;
export const K_MAX = 120;

// Below this many rated games, a player's tier is still "provisional" --
// shown to the client so it can display "X of PROVISIONAL_GAMES_THRESHOLD
// rated games played" instead of hardcoding the number a second time.
export const PROVISIONAL_GAMES_THRESHOLD = 3;

const GAP_PENALTY_COEFFICIENT = 0.1;
const GAP_PENALTY_CAP = 50;

const MOV_REFERENCE_MARGIN = 2; // a "close game" margin, e.g. 21-19
const MOV_DAMPENING_CONSTANT = 2.2;
const MOV_DAMPENING_SCALE = 0.001;
export const MOV_MULTIPLIER_MIN = 0.6;
export const MOV_MULTIPLIER_MAX = 1.8;

const SEASON_POINTS_BASE = 10;
const SEASON_POINTS_OPPONENT_MULT_MIN = 0.5;
const SEASON_POINTS_OPPONENT_MULT_MAX = 2.0;
const SEASON_POINTS_STREAK_CAP = 5;
const SEASON_POINTS_STREAK_WEIGHT = 2;

const REPEAT_PENALTY_STEP = 0.15;
const REPEAT_PENALTY_FLOOR = 0.4;

// A guest has no account, so no persistent MMR -- their declared session level
// stands in as an estimate for everyone else's calculation. Evenly spaced
// around the 1000 baseline, matching the existing A-E level scale.
export const GUEST_LEVEL_MMR: Record<string, number> = {
  A: 1300,
  B: 1150,
  C: 1000,
  D: 850,
  E: 700,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Not a plain average -- a big internal skill gap weakens a team's effective
// strength, since doubles opponents tend to target the weaker player.
export function teamEffectiveRating(mmrA: number, mmrB: number): number {
  const avg = (mmrA + mmrB) / 2;
  const penalty = Math.min(GAP_PENALTY_CAP, GAP_PENALTY_COEFFICIENT * Math.abs(mmrA - mmrB));
  return avg - penalty;
}

// Standard Elo expected score, applied per player against the opposing team's
// effective rating (not their own team's average) -- this is what makes
// doubles rating changes fair without a separate "contribution" model.
export function expectedScore(playerMmr: number, opponentTeamRating: number): number {
  return 1 / (1 + Math.pow(10, (opponentTeamRating - playerMmr) / 400));
}

// K scales with how uncertain we still are about this player (their RD), not
// a hardcoded games-played bracket -- smoothly large early, smoothly normal later.
export function kFactorFor(ratingDeviation: number): number {
  return clamp(K_BASE * (ratingDeviation / RD_FLOOR), K_BASE, K_MAX);
}

// RD shrinks (more confidence) after each rated match.
export function decayRatingDeviation(ratingDeviation: number): number {
  return Math.max(RD_FLOOR, ratingDeviation * RD_MATCH_DECAY);
}

// RD grows back (less confidence) the longer a player goes without a rated
// match -- adapted from Glickman's published Glicko pre-rating-period growth.
export function growRatingDeviationForInactivity(ratingDeviation: number, daysSinceLastMatch: number): number {
  const periods = daysSinceLastMatch / RD_INACTIVITY_PERIOD_DAYS;
  const grown = Math.sqrt(ratingDeviation * ratingDeviation + RD_INACTIVITY_C * RD_INACTIVITY_C * periods);
  return Math.min(RD_MAX, grown);
}

// Logarithmic margin scaling, dampened when the result was already expected --
// adapted from FiveThirtyEight's published NFL/NBA Elo methodology. Prevents
// both "21-0 explodes the rating" and "farm a weak opponent for free margin."
export function marginMultiplier(winnerScore: number, loserScore: number, eloDiffOfWinner: number): number {
  const margin = Math.max(1, Math.abs(winnerScore - loserScore));
  const movRatio = Math.log(margin + 1) / Math.log(MOV_REFERENCE_MARGIN + 1);
  const dampening = MOV_DAMPENING_CONSTANT / (MOV_DAMPENING_SCALE * eloDiffOfWinner + MOV_DAMPENING_CONSTANT);
  return clamp(movRatio * dampening, MOV_MULTIPLIER_MIN, MOV_MULTIPLIER_MAX);
}

// Diminishing returns for repeatedly facing the same opponent or partnering
// the same teammate in a short window -- resists farming without accusing
// anyone of anything; it just quietly caps the reward for doing it.
export function repeatPenaltyMultiplier(recentMeetings: number): number {
  return clamp(1 - REPEAT_PENALTY_STEP * Math.max(0, recentMeetings - 1), REPEAT_PENALTY_FLOOR, 1);
}

export function seasonPointsForWin(opponentTeamRating: number, currentStreak: number): number {
  const opponentMultiplier = clamp(
    opponentTeamRating / BASE_MMR,
    SEASON_POINTS_OPPONENT_MULT_MIN,
    SEASON_POINTS_OPPONENT_MULT_MAX,
  );
  const streakBonus = Math.min(Math.max(0, currentStreak - 1), SEASON_POINTS_STREAK_CAP) * SEASON_POINTS_STREAK_WEIGHT;
  return Math.round(SEASON_POINTS_BASE * opponentMultiplier + streakBonus);
}

export interface TierInfo {
  tier: string;
  division: "I" | "II" | "III" | null;
  provisional: boolean;
}

// Fixed MMR thresholds -- the simplest, most transparent mapping. Season
// Points already covers the "achievement" layer, so this stays plain.
export function mmrToTier(mmr: number, ratedGamesPlayed: number, ratingDeviation: number): TierInfo {
  const provisional = ratedGamesPlayed < PROVISIONAL_GAMES_THRESHOLD || ratingDeviation >= 200;

  if (mmr < 900) return { tier: "Fledgling", division: null, provisional };
  if (mmr >= 1500) return { tier: "Legend", division: null, provisional };

  const bands: [string, number][] = [
    ["Rally", 900],
    ["Smash", 1050],
    ["Ace", 1200],
    ["Champion", 1350],
  ];
  for (let i = bands.length - 1; i >= 0; i--) {
    const [tier, floor] = bands[i];
    if (mmr >= floor) {
      const offset = mmr - floor;
      const division: "I" | "II" | "III" = offset >= 100 ? "I" : offset >= 50 ? "II" : "III";
      return { tier, division, provisional };
    }
  }
  // Unreachable given the bounds above, but keeps the function total.
  return { tier: "Fledgling", division: null, provisional };
}

function playerResult(
  player: RatedPlayer,
  opponentTeamRating: number,
  teammateMmr: number,
  won: boolean,
  mult: number,
): PlayerRatingResult {
  const accountId = player.accountId as number; // caller only invokes this for players with an account
  const expected = expectedScore(player.effectiveMmr, opponentTeamRating);
  const k = kFactorFor(player.ratingDeviation);
  const base = k * ((won ? 1 : 0) - expected);
  const antiFarming = Math.min(
    repeatPenaltyMultiplier(player.recentMeetingsWithOpponents ?? 0),
    repeatPenaltyMultiplier(player.recentMatchesWithTeammate ?? 0),
  );
  const change = Math.round(base * mult * antiFarming);

  const newRd = decayRatingDeviation(player.ratingDeviation);
  const seasonChange = won ? seasonPointsForWin(opponentTeamRating, player.currentStreak) : 0;

  return {
    accountId,
    previousMmr: player.effectiveMmr,
    newMmr: player.effectiveMmr + change,
    mmrChange: change,
    previousRatingDeviation: player.ratingDeviation,
    newRatingDeviation: newRd,
    previousSeasonPoints: player.seasonPoints,
    newSeasonPoints: player.seasonPoints + seasonChange,
    seasonPointsChange: seasonChange,
    expectedWinProbability: expected,
    kFactor: k,
    marginMultiplier: mult,
    antiFarmingMultiplier: antiFarming,
    opponentAvgMmr: opponentTeamRating,
    teammateMmr,
    won,
  };
}

// The main entry point: rate one completed match. Returns `rated: false` with
// a reason if the match isn't eligible (any chill-mode player involved, or a
// tied score, which badminton doesn't produce but a bad data entry might).
// Only players with an accountId appear in `results` -- guests never get a
// result written back, even though their estimated rating was used in the math.
export function rateMatch(input: MatchRatingInput): MatchRatingResult {
  const allPlayers = [...input.team1, ...input.team2];

  if (allPlayers.some((p) => p.playingMode === "chill")) {
    return { rated: false, reason: "A chill-mode player was involved", results: [] };
  }
  if (input.score1 === input.score2) {
    return { rated: false, reason: "Tied score can't be rated", results: [] };
  }

  const team1Rating = teamEffectiveRating(input.team1[0].effectiveMmr, input.team1[1].effectiveMmr);
  const team2Rating = teamEffectiveRating(input.team2[0].effectiveMmr, input.team2[1].effectiveMmr);
  const team1Won = input.score1 > input.score2;

  const winnerScore = team1Won ? input.score1 : input.score2;
  const loserScore = team1Won ? input.score2 : input.score1;
  const winnerRating = team1Won ? team1Rating : team2Rating;
  const loserRating = team1Won ? team2Rating : team1Rating;
  const mult = marginMultiplier(winnerScore, loserScore, winnerRating - loserRating);

  const results: PlayerRatingResult[] = [];

  for (const player of input.team1) {
    if (player.accountId == null) continue;
    const teammate = input.team1.find((p) => p !== player)!;
    results.push(playerResult(player, team2Rating, teammate.effectiveMmr, team1Won, mult));
  }
  for (const player of input.team2) {
    if (player.accountId == null) continue;
    const teammate = input.team2.find((p) => p !== player)!;
    results.push(playerResult(player, team1Rating, teammate.effectiveMmr, !team1Won, mult));
  }

  return { rated: true, results };
}

// ---- Anti-farming / anti-abuse flags (for a host to review -- never automatic) ----

export interface SuspiciousActivityContext {
  accountId: number;
  recentMeetingsWithSameOpponent: number; // in e.g. the last 7 days
  matchesInLastHour: number;
  claimedLevel: string;
  mmr: number;
}

export function flagSuspiciousActivity(ctx: SuspiciousActivityContext): string[] {
  const flags: string[] = [];
  if (ctx.recentMeetingsWithSameOpponent >= 5) {
    flags.push(`Played the same opponent ${ctx.recentMeetingsWithSameOpponent} times recently`);
  }
  if (ctx.matchesInLastHour >= 8) {
    flags.push(`${ctx.matchesInLastHour} matches in the last hour -- unusually fast pace`);
  }
  const estimate = GUEST_LEVEL_MMR[ctx.claimedLevel] ?? BASE_MMR;
  if (Math.abs(estimate - ctx.mmr) >= 300) {
    flags.push(`Declared level ${ctx.claimedLevel} is far from their MMR (${Math.round(ctx.mmr)})`);
  }
  return flags;
}
