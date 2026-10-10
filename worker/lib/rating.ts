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
  /**
   * This player's current A-E skill level (the host-approved session level,
   * not a guest's one-off declared level) -- used only to look up their rank
   * ceiling/target (see LEVEL_MMR_CAP / LEVEL_MMR_TARGET below). Optional:
   * when omitted, levelAdjustedGainMultiplier always returns 1 and the
   * ceiling clamp never applies, so any caller that doesn't supply one keeps
   * fully uncapped, unboosted behavior -- identical to before this existed.
   */
  level?: string;
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
  levelAdjustedMultiplier: number;
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

// ---- Level-based rank ceiling / catch-up ----
//
// The problem: nothing used to stop a registered account's mmr from climbing
// to Legend regardless of what level the host actually approved them at --
// which also means setting your own level artificially low (to face easier
// opponents) had no real downside. The fix is two tables keyed by the
// player's current *host-approved session level* (never a guest's one-off
// declared level, and never the self-reported account-level players set in
// Account settings -- see worker/lib/ratingIntegration.ts for which one is
// actually threaded through):
//
// - LEVEL_MMR_TARGET: the rank each level is "supposed" to be working
//   towards -- the top of that level's matching tier (see mmrToTier), except
//   for A, whose target is the *floor* of Legend (Legend itself has no top).
//   levelAdjustedGainMultiplier boosts MMR gains on wins (up to +50%) the
//   further below this a player's current mmr is, tapering back down to the
//   normal 1x rate as they approach it -- this is the "catch-up" half.
// - LEVEL_MMR_CAP: the hard ceiling a level can never be rated above via a
//   win (a loss is always applied normally -- this only blocks climbing
//   further, it's never a floor). Identical to LEVEL_MMR_TARGET for every
//   level except A, which has no ceiling at all (Infinity) since Legend is
//   already the top tier.
//
// Both tables fall back to Infinity for an unrecognized/missing level, which
// makes levelAdjustedGainMultiplier a no-op (returns 1) and skips the ceiling
// clamp entirely -- so a caller that never passes RatedPlayer.level (as in
// every pre-existing test/usage before this was added) sees no change at all.
export const LEVEL_MMR_TARGET: Record<string, number> = {
  E: 1049, // top of Rally
  D: 1199, // top of Smash
  C: 1349, // top of Ace
  B: 1499, // top of Champion
  A: 1500, // floor of Legend
};
export const LEVEL_MMR_CAP: Record<string, number> = {
  E: 1049,
  D: 1199,
  C: 1349,
  B: 1499,
  A: Infinity, // Legend has no ceiling
};

function targetForLevel(level: string | undefined): number {
  if (!level) return Infinity;
  return LEVEL_MMR_TARGET[level] ?? Infinity;
}

function capForLevel(level: string | undefined): number {
  if (!level) return Infinity;
  return LEVEL_MMR_CAP[level] ?? Infinity;
}

const CATCHUP_MAX_BONUS = 0.5; // up to +50% MMR gain far below the target
const CATCHUP_FULL_GAP = 250; // 250+ points below target => the full bonus
const CATCHUP_TAPER_GAP = 50; // within 50 points of target (or at/above it) => normal 1x rate

// A single smooth curve: 1 + up to CATCHUP_MAX_BONUS when far below `target`,
// tapering down to exactly 1 (no bonus, but no penalty either) once within
// CATCHUP_TAPER_GAP of it or above it. Only ever applied to wins -- the
// separate hard ceiling (LEVEL_MMR_CAP) is what actually stops further
// climbing once a player's at the top of their level's range.
export function levelAdjustedGainMultiplier(currentMmr: number, target: number): number {
  if (!Number.isFinite(target)) return 1;
  const distanceBelowTarget = target - currentMmr;
  if (distanceBelowTarget <= CATCHUP_TAPER_GAP) return 1;
  if (distanceBelowTarget >= CATCHUP_FULL_GAP) return 1 + CATCHUP_MAX_BONUS;
  const t = (distanceBelowTarget - CATCHUP_TAPER_GAP) / (CATCHUP_FULL_GAP - CATCHUP_TAPER_GAP);
  return 1 + CATCHUP_MAX_BONUS * t;
}

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

// Lowest to highest -- used wherever a (tier, division) pair needs a single
// comparable number instead of the raw MMR behind it (detecting a rank-up,
// sorting a leaderboard by rank, plotting rank over time): all places that
// deliberately show a tier, never the hidden number (see mmrToTier's doc
// comment above and publicRatingView in ratingIntegration.ts). Division only
// applies to the four middle tiers; Fledgling and Legend pass division: null
// and compare by tier alone. Mirrors src/api.ts's rankScore (kept duplicated
// there rather than shared, since that one lives in the frontend bundle).
const TIER_ORDER = ["Fledgling", "Rally", "Smash", "Ace", "Champion", "Legend"];

export function rankScore(tier: string, division: "I" | "II" | "III" | null): number {
  const tierIndex = TIER_ORDER.indexOf(tier);
  const divisionIndex = division === "I" ? 2 : division === "II" ? 1 : 0; // "III" or null -> 0
  return tierIndex * 3 + divisionIndex;
}

// Same tier floors as mmrToTier (plus one virtual floor 150 points below
// Rally, purely so Fledgling gets a meaningful bar instead of always reading
// "0%"), reduced to a plain 0-100 percent of the way to the next tier up --
// never the raw mmr itself, same "tier, not a number" rule as mmrToTier.
// nextTier is null once there's nowhere left to climb (already Legend).
const TIER_FLOORS: [string, number][] = [
  ["Fledgling", 750],
  ["Rally", 900],
  ["Smash", 1050],
  ["Ace", 1200],
  ["Champion", 1350],
  ["Legend", 1500],
];

export function progressToNextTier(mmr: number): { percent: number; nextTier: string | null } {
  if (mmr >= 1500) return { percent: 100, nextTier: null };

  for (let i = TIER_FLOORS.length - 2; i >= 0; i--) {
    const [, floor] = TIER_FLOORS[i];
    if (mmr >= floor) {
      const [nextTier, nextFloor] = TIER_FLOORS[i + 1];
      const percent = Math.round(((mmr - floor) / (nextFloor - floor)) * 100);
      return { percent: clamp(percent, 0, 100), nextTier };
    }
  }
  // Below even the virtual Fledgling floor -- an empty bar, still climbing
  // toward Rally.
  return { percent: 0, nextTier: TIER_FLOORS[1][0] };
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
  // Only relevant on a win: a loss is never boosted (no reason to) or capped
  // (it can't push you over a ceiling), so this stays at 1 for a loss.
  const levelAdjusted = won ? levelAdjustedGainMultiplier(player.effectiveMmr, targetForLevel(player.level)) : 1;
  const rawChange = Math.round(base * mult * antiFarming * levelAdjusted);

  // Hard backstop: even with the smooth catch-up/taper curve above, a single
  // big win could still land past the cap -- this is what actually guarantees
  // a level can never be rated above its ceiling (Infinity for A, so this is
  // a no-op there). Never applied to a loss.
  const uncappedNewMmr = player.effectiveMmr + rawChange;
  const cap = capForLevel(player.level);
  const newMmr = won && Number.isFinite(cap) ? Math.min(uncappedNewMmr, cap) : uncappedNewMmr;
  const change = newMmr - player.effectiveMmr;

  const newRd = decayRatingDeviation(player.ratingDeviation);
  const seasonChange = won ? seasonPointsForWin(opponentTeamRating, player.currentStreak) : 0;

  return {
    accountId,
    previousMmr: player.effectiveMmr,
    newMmr,
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
    levelAdjustedMultiplier: levelAdjusted,
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
