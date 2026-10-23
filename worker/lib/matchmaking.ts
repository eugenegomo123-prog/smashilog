// Shared badminton doubles matchmaking logic.
// Pure functions operating on plain player objects so they're easy to reason about
// and reuse -- from the suggestion-generation flow in regenerate.ts (the Worker),
// and directly from the host UI (src/pages/HostSession.tsx) to display a quality
// grade for a match using the exact same formula the generator used to pick it.
// This file still has zero imports and no I/O, which is what makes sharing it
// between the two safe (see matchQuality()'s doc comment below for more).
//
// --- How match selection works, in one pass ---
// Every candidate match (a specific 4-player group split into team1 vs team2) is
// reduced to a `MatchMetrics` tuple (see below) and candidates are compared by
// going down that tuple field by field, deciding on the first field that differs
// -- true tiered/lexicographic priority, not a single weighted score. This is
// deliberate: a weighted sum risks letting an extreme wait time or a repeat-
// partner penalty outweigh a real skill-level mismatch (exactly what this
// module's design brief calls out as the thing to avoid). With a strict tiered
// comparison, `maxSkillSpread` can *never* be overridden by anything after it --
// two candidates only ever get compared on `totalSkillDistance` when their
// spreads are exactly equal, only compared on rotation fairness when every
// skill-quality field above it is also tied, and so on. The tiers, in order:
//   1. maxSkillSpread           -- highest level minus lowest, across all 4.
//   2. totalSkillDistance       -- sum of all 6 pairwise level distances.
//   3. teamStrengthDifference   -- |team1 total level score - team2's|.
//   4. withinTeamSkillGap       -- how far apart each team's own two partners
//                                  are, as a tiebreak among equally
//                                  team-balanced splits (see its own note
//                                  below -- team balance still wins first).
//   5. gamesPlayedPenalty       -- total games already played by these 4.
//   6. waitPriority             -- (negative) total time since each player's
//                                  last completed match -- longer wait sorts
//                                  first.
//   7. consecutiveGamePenalty   -- how many of the 4 just came off a court.
//   8. repeatPartnerPenalty     -- avoid repeating (and reward preferring) a
//                                  stated partner.
//   9. repeatOpponentPenalty    -- a smaller nudge away from repeat opponents.
//  10. matchupFrequencyPenalty  -- avoid cycling the exact same 4-player group.
//  11. tieBreak                 -- a final, deterministic (not random) tiebreak
//                                  so identical inputs always produce the same
//                                  output (sum of player ids).
// See `metricsOf` and `compareMetrics` for the implementation, and the module's
// originating design brief for why each tier sits where it does.
//
// `generateSuggestedMatches` is the public entry point, and it's tiered at a
// higher level too: the top half of the budget comes from
// `generateBalancedMatches` (jointly optimizing roughly a round's worth of
// courts at a time, so a weaker player isn't stranded for the later courts --
// see `optimizeRound`'s doc comment), the bottom half from
// `generateFairnessMatches` (plain priority order, no joint optimization). The
// second tier exists specifically to rescue a skill outlier the first tier's
// greedy construction can structurally strand -- see that function's own doc
// comment for the worked example.
//
// --- Performance ---
// The shortlist handed to `optimizeRound` is capped (roughly one round's worth
// of courts + 8 spare players), so even a 30-player/3-court session only ever
// jointly optimizes ~20 players at a time -- bounded greedy construction
// (O(shortlist^3) for the worst single pick, trivial at this size) followed by
// a capped number of pairwise-swap improvement passes, each comparing
// `MatchMetrics` tuples rather than scanning permutations of the full pool.

export interface PlayerForMatchmaking {
  id: number;
  level: string; // A-E
  currentStreak: number;
  pointsFor: number;
  pointsAgainst: number;
  gamesPlayed: number;
  lastMatchEndedAt: string | null;
  preferredPartnerId: number | null;
}

// A = highest, E = lowest. Used only for scoring -- never for display (see
// AGENTS.md: letters are what's shown everywhere in the UI/API). Consecutive
// integers, so a distance of 1 below is exactly "one adjacent skill level" as
// the project's matchmaking design brief requires.
const LEVEL_SCORE: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, E: 1 };

function levelScore(level: string): number {
  return LEVEL_SCORE[level] ?? 3;
}

function levelDistance(a: string, b: string): number {
  return Math.abs(levelScore(a) - levelScore(b));
}

// Sort the eligible pool by matchmaking priority: fewest games played first, then
// longest time since their last match ended (nulls = never played = highest
// priority). Used to pick which players `optimizeRound` tries as a group "anchor"
// first, and as the walk order for the plain fairness tier -- the actual
// final ranking of candidate matches always goes through `compareMetrics`
// below, this just decides construction order.
export function sortByPriority(pool: PlayerForMatchmaking[]): PlayerForMatchmaking[] {
  return [...pool].sort((a, b) => {
    if (a.gamesPlayed !== b.gamesPlayed) return a.gamesPlayed - b.gamesPlayed;
    const aTime = a.lastMatchEndedAt ? new Date(a.lastMatchEndedAt).getTime() : 0;
    const bTime = b.lastMatchEndedAt ? new Date(b.lastMatchEndedAt).getTime() : 0;
    return aTime - bTime;
  });
}

// ---------------------------------------------------------------------------
// Session history this module needs to evaluate fairness/variety -- who's
// partnered/opposed whom, how often, and who just came off a court. Built once
// per regenerate call from the session's completed matches (see regenerate.ts's
// buildPairHistory) and passed in rather than fetched here, since this module
// has no I/O of its own. All derived from existing completed-match records --
// nothing new is stored to produce it (see this module's design brief, section
// 8: "never fabricate missing history... use existing fields and records
// whenever possible").
// ---------------------------------------------------------------------------

export interface PairHistory {
  // Keyed by the two player ids, canonicalized low-id-first ("12-47") so order
  // doesn't matter -- see pairKeyOfIds.
  partnerCounts: Map<string, number>;
  opponentCounts: Map<string, number>;
  // Each player's partner/an opponent from their single most-recently-completed
  // match, if any -- a stronger, separate nudge on top of the plain counts
  // above, since the brief specifically calls out penalizing an *immediate*
  // repeat more than one that happened several games back.
  lastPartnerOf: Map<number, number>;
  lastOpponentOf: Map<number, number>;
  // How many times this exact 4-player group (regardless of how it was split
  // into teams) has already played together this session -- keyed by the 4
  // ids sorted and joined, see groupKeyOfIds.
  groupCounts: Map<string, number>;
  // Players who were in the single most-recently-completed match in the
  // session (there's at most one such match at any instant, so this is always
  // 0, 2 or 4 ids) -- "just came off a court," independent of exact elapsed
  // minutes, and the thing Priority 4's "penalize back-to-back games" asks for.
  justPlayedIds: Set<number>;
}

export const EMPTY_HISTORY: PairHistory = {
  partnerCounts: new Map(),
  opponentCounts: new Map(),
  lastPartnerOf: new Map(),
  lastOpponentOf: new Map(),
  groupCounts: new Map(),
  justPlayedIds: new Set(),
};

function pairKeyOfIds(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function groupKeyOfIds(ids: number[]): string {
  return [...ids].sort((x, y) => x - y).join(",");
}

function preferredTogether(a: PlayerForMatchmaking, b: PlayerForMatchmaking): boolean {
  return a.preferredPartnerId === b.id || b.preferredPartnerId === a.id;
}

// ---------------------------------------------------------------------------
// Quality grade -- a pure function of the four players' levels only.
// ---------------------------------------------------------------------------

export type MatchGrade = "excellent" | "good" | "fair" | "uneven" | "poor";

export interface MatchQuality {
  grade: MatchGrade;
  emoji: string;
  label: string;
  // The same skill-spread + skill-distance + team-balance cost used below to
  // grade this split -- exposed so the grade's "why" can be inspected/tested,
  // not just the bucketed label.
  cost: number;
}

const GRADE_INFO: Record<MatchGrade, { emoji: string; label: string }> = {
  excellent: { emoji: "🟢", label: "Excellent" },
  good: { emoji: "🔵", label: "Good" },
  fair: { emoji: "🟡", label: "Fair" },
  uneven: { emoji: "🟠", label: "Uneven" },
  poor: { emoji: "🔴", label: "Poor" },
};

// Weights for the skill-similarity + team-balance half of the cost function --
// the half that's independent of rest/history and therefore safe to expose as a
// standalone "quality" of a given team1-vs-team2 split. Spread dominates
// (highest level minus lowest -- the project's matchmaking brief's top
// priority), total pairwise skill distance is next (so e.g. "A+E vs A+E", a
// bimodal two-extreme group, still grades worse than a tighter group even when
// both happen to share the same highest-lowest gap -- distance sees the whole
// shape, not just the two extremes), and team balance is last.
const SPREAD_WEIGHT = 4;
const DISTANCE_WEIGHT = 0.5;
const BALANCE_WEIGHT = 1;

function skillBalanceCost(team1Levels: [string, string], team2Levels: [string, string]): number {
  const four = [team1Levels[0], team1Levels[1], team2Levels[0], team2Levels[1]];
  const scores = four.map(levelScore);
  const spread = Math.max(...scores) - Math.min(...scores);
  let totalDistance = 0;
  for (let i = 0; i < four.length; i++) {
    for (let j = i + 1; j < four.length; j++) {
      totalDistance += Math.abs(scores[i] - scores[j]);
    }
  }
  const team1Sum = levelScore(team1Levels[0]) + levelScore(team1Levels[1]);
  const team2Sum = levelScore(team2Levels[0]) + levelScore(team2Levels[1]);
  const imbalance = Math.abs(team1Sum - team2Sum);
  return SPREAD_WEIGHT * spread + DISTANCE_WEIGHT * totalDistance + BALANCE_WEIGHT * imbalance;
}

// Grade thresholds, calibrated against the worked examples in this module's
// design brief: all-same-level is always cost 0 (excellent); a one-level
// spread lands at 6-8 depending on team balance (good); a balanced two-level
// spread lands at 12 (fair); three levels at 18 (uneven); the extreme
// four-level "A+E vs A+E" case -- equal team averages hiding a huge individual
// mismatch, called out explicitly in the brief as something that must NOT
// grade as excellent -- lands at 24 (poor).
export function matchQuality(team1Levels: [string, string], team2Levels: [string, string]): MatchQuality {
  const cost = skillBalanceCost(team1Levels, team2Levels);
  let grade: MatchGrade;
  if (cost <= 2) grade = "excellent";
  else if (cost <= 8) grade = "good";
  else if (cost <= 12) grade = "fair";
  else if (cost <= 18) grade = "uneven";
  else grade = "poor";
  return { grade, cost, ...GRADE_INFO[grade] };
}

// ---------------------------------------------------------------------------
// MatchMetrics -- the full, tiered description of one candidate match used to
// pick between candidates. See the module doc comment at the top of this file
// for the tier order and why it's compared lexicographically, field by field,
// rather than folded into one weighted number.
// ---------------------------------------------------------------------------

export interface MatchMetrics {
  maxSkillSpread: number;
  totalSkillDistance: number;
  teamStrengthDifference: number;
  withinTeamSkillGap: number;
  gamesPlayedPenalty: number;
  waitPriority: number;
  consecutiveGamePenalty: number;
  repeatPartnerPenalty: number;
  repeatOpponentPenalty: number;
  matchupFrequencyPenalty: number;
  tieBreak: number;
}

// A never-played player waits "forever" -- a large but finite sentinel (not
// Infinity, which would turn into NaN the moment two such players are
// subtracted from each other in compareMetrics). ~19 years in minutes is far
// larger than any real session, so it always sorts ahead of a real wait time
// without any risk of the arithmetic below overflowing or going non-finite.
const NEVER_PLAYED_WAIT_MINUTES = 1e7;

function waitMinutesOf(p: PlayerForMatchmaking, nowMs: number): number {
  if (!p.lastMatchEndedAt) return NEVER_PLAYED_WAIT_MINUTES;
  const endedMs = new Date(p.lastMatchEndedAt).getTime();
  const elapsedMs = nowMs - endedMs;
  // A missing/invalid/future timestamp shouldn't crash matchmaking or be
  // mistaken for a long wait (see the brief's "handle missing or invalid
  // timestamps safely") -- treat it as "just played" instead, the safest
  // (least-favored) fallback rather than fabricating a wait.
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  return elapsedMs / 60000;
}

// Extra cost added when a pairing would repeat either player's most recent
// partner, scaled further by how many times they've partnered this session,
// and a discount applied when a pairing matches either player's stated
// preferred partner -- all three combined into this one tier (see the module
// doc comment: within a tier, blending related sub-signals is fine; it's
// *across* tiers that a weighted blend would be a problem). Sized so an
// immediate repeat always costs more than a handful of partnerships earlier
// in the session, and so the preferred-partner bonus nudges without ever
// being able to out-cost an immediate repeat.
const MOST_RECENT_PARTNER_PENALTY = 3;
const PARTNER_COUNT_PENALTY = 1;
const PREFERRED_PARTNER_BONUS = 2;

function partnerPenalty(a: PlayerForMatchmaking, b: PlayerForMatchmaking, history: PairHistory): number {
  const isMostRecent = history.lastPartnerOf.get(a.id) === b.id || history.lastPartnerOf.get(b.id) === a.id;
  const count = history.partnerCounts.get(pairKeyOfIds(a.id, b.id)) ?? 0;
  const preferred = preferredTogether(a, b);
  return (
    (isMostRecent ? MOST_RECENT_PARTNER_PENALTY : 0) + count * PARTNER_COUNT_PENALTY - (preferred ? PREFERRED_PARTNER_BONUS : 0)
  );
}

// Same idea as the partner penalty above but smaller throughout -- playing
// against someone again is a much milder repeat than partnering them again
// (the brief: "do not treat playing against someone as the same thing as
// being their partner").
const MOST_RECENT_OPPONENT_PENALTY = 1.5;
const OPPONENT_COUNT_PENALTY = 0.5;

function opponentPenaltyBetween(a: PlayerForMatchmaking, b: PlayerForMatchmaking, history: PairHistory): number {
  const isMostRecent = history.lastOpponentOf.get(a.id) === b.id || history.lastOpponentOf.get(b.id) === a.id;
  const count = history.opponentCounts.get(pairKeyOfIds(a.id, b.id)) ?? 0;
  return (isMostRecent ? MOST_RECENT_OPPONENT_PENALTY : 0) + count * OPPONENT_COUNT_PENALTY;
}

// Computes the full tiered metrics for one fully-specified candidate match (a
// 4-player group already split into team1 vs team2). `now` is the reference
// time for wait-priority, passed in (rather than read live) so suggestion
// generation is deterministic and testable.
export function metricsOf(
  team1: [PlayerForMatchmaking, PlayerForMatchmaking],
  team2: [PlayerForMatchmaking, PlayerForMatchmaking],
  history: PairHistory,
  now: number,
): MatchMetrics {
  const four = [team1[0], team1[1], team2[0], team2[1]];
  const scores = four.map((p) => levelScore(p.level));
  const maxSkillSpread = Math.max(...scores) - Math.min(...scores);

  let totalSkillDistance = 0;
  for (let i = 0; i < four.length; i++) {
    for (let j = i + 1; j < four.length; j++) {
      totalSkillDistance += Math.abs(scores[i] - scores[j]);
    }
  }

  const team1Sum = levelScore(team1[0].level) + levelScore(team1[1].level);
  const team2Sum = levelScore(team2[0].level) + levelScore(team2[1].level);
  const teamStrengthDifference = Math.abs(team1Sum - team2Sum);

  // Secondary to team balance above -- only breaks ties between splits that
  // are already equally balanced by team sum (see the module doc comment's
  // note on this tier: a handicap pairing of one strong + one weak player per
  // side can be the *better*-balanced split even though it isn't the smallest
  // within-team gap, so team balance has to win first).
  const withinTeamSkillGap = levelDistance(team1[0].level, team1[1].level) + levelDistance(team2[0].level, team2[1].level);

  const gamesPlayedPenalty = four.reduce((sum, p) => sum + p.gamesPlayed, 0);
  const waitPriority = -four.reduce((sum, p) => sum + waitMinutesOf(p, now), 0);
  const consecutiveGamePenalty = four.reduce((n, p) => n + (history.justPlayedIds.has(p.id) ? 1 : 0), 0);

  const repeatPartnerPenalty =
    partnerPenalty(team1[0], team1[1], history) + partnerPenalty(team2[0], team2[1], history);

  const repeatOpponentPenalty =
    opponentPenaltyBetween(team1[0], team2[0], history) +
    opponentPenaltyBetween(team1[0], team2[1], history) +
    opponentPenaltyBetween(team1[1], team2[0], history) +
    opponentPenaltyBetween(team1[1], team2[1], history);

  const matchupFrequencyPenalty = history.groupCounts.get(groupKeyOfIds(four.map((p) => p.id))) ?? 0;

  // Deterministic tiebreak for when every tier above is genuinely tied --
  // intentionally not random, so identical inputs always produce identical
  // output (see the design brief's "tie-breaking stability" requirement).
  const tieBreak = four.reduce((sum, p) => sum + p.id, 0);

  return {
    maxSkillSpread,
    totalSkillDistance,
    teamStrengthDifference,
    withinTeamSkillGap,
    gamesPlayedPenalty,
    waitPriority,
    consecutiveGamePenalty,
    repeatPartnerPenalty,
    repeatOpponentPenalty,
    matchupFrequencyPenalty,
    tieBreak,
  };
}

// Strict lexicographic/tiered comparison: negative when `a` is the better
// (preferred) candidate, positive when `b` is, 0 only when every tier is
// exactly equal. Each `||` only falls through to the next tier when the
// current one is an exact tie (0 is falsy) -- see the module doc comment for
// why this, rather than a weighted sum, is what guarantees a higher-priority
// tier can never be overridden by a lower one.
export function compareMetrics(a: MatchMetrics, b: MatchMetrics): number {
  return (
    a.maxSkillSpread - b.maxSkillSpread ||
    a.totalSkillDistance - b.totalSkillDistance ||
    a.teamStrengthDifference - b.teamStrengthDifference ||
    a.withinTeamSkillGap - b.withinTeamSkillGap ||
    a.gamesPlayedPenalty - b.gamesPlayedPenalty ||
    a.waitPriority - b.waitPriority ||
    a.consecutiveGamePenalty - b.consecutiveGamePenalty ||
    a.repeatPartnerPenalty - b.repeatPartnerPenalty ||
    a.repeatOpponentPenalty - b.repeatOpponentPenalty ||
    a.matchupFrequencyPenalty - b.matchupFrequencyPenalty ||
    a.tieBreak - b.tieBreak
  );
}

// Elementwise sum of two MatchMetrics -- used only to let `optimizeRound`'s
// local-search swap phase ask "does swapping a player between these two
// *groups* improve their combined, still fully tiered, profile" without ever
// collapsing either group's metrics to a single blended number first. Summing
// is safe here because every field's "lower is better" direction is preserved
// by addition, and `compareMetrics` is then applied to the sums exactly as it
// would be to a single candidate's metrics.
function addMetrics(a: MatchMetrics, b: MatchMetrics): MatchMetrics {
  return {
    maxSkillSpread: a.maxSkillSpread + b.maxSkillSpread,
    totalSkillDistance: a.totalSkillDistance + b.totalSkillDistance,
    teamStrengthDifference: a.teamStrengthDifference + b.teamStrengthDifference,
    withinTeamSkillGap: a.withinTeamSkillGap + b.withinTeamSkillGap,
    gamesPlayedPenalty: a.gamesPlayedPenalty + b.gamesPlayedPenalty,
    waitPriority: a.waitPriority + b.waitPriority,
    consecutiveGamePenalty: a.consecutiveGamePenalty + b.consecutiveGamePenalty,
    repeatPartnerPenalty: a.repeatPartnerPenalty + b.repeatPartnerPenalty,
    repeatOpponentPenalty: a.repeatOpponentPenalty + b.repeatOpponentPenalty,
    matchupFrequencyPenalty: a.matchupFrequencyPenalty + b.matchupFrequencyPenalty,
    tieBreak: a.tieBreak + b.tieBreak,
  };
}

// ---------------------------------------------------------------------------
// Split selection -- given a fixed foursome, which 2v2 split is best.
// ---------------------------------------------------------------------------

export interface SuggestedSplit {
  team1: [PlayerForMatchmaking, PlayerForMatchmaking];
  team2: [PlayerForMatchmaking, PlayerForMatchmaking];
}

function allSplits(
  four: PlayerForMatchmaking[],
): [[PlayerForMatchmaking, PlayerForMatchmaking], [PlayerForMatchmaking, PlayerForMatchmaking]][] {
  const [a, b, c, d] = four;
  return [
    [
      [a, b],
      [c, d],
    ],
    [
      [a, c],
      [b, d],
    ],
    [
      [a, d],
      [b, c],
    ],
  ];
}

// All 3 ways to split 4 players into two teams, ranked best (most-preferred by
// compareMetrics) to worst.
function allSplitsRanked(
  four: PlayerForMatchmaking[],
  history: PairHistory,
  now: number,
): (SuggestedSplit & { metrics: MatchMetrics })[] {
  return allSplits(four)
    .map(([team1, team2]) => ({ team1, team2, metrics: metricsOf(team1, team2, history, now) }))
    .sort((x, y) => compareMetrics(x.metrics, y.metrics));
}

// Given exactly 4 players, find the 2v2 split the tiered comparator prefers:
// closest team balance first (with within-team gap as its own tiebreak), then
// whichever split best respects stated partner preferences and avoids either
// player's most recent partner/opponent.
export function bestSplit(four: PlayerForMatchmaking[], history: PairHistory, now: number): SuggestedSplit & { metrics: MatchMetrics } {
  return allSplitsRanked(four, history, now)[0];
}

// ---------------------------------------------------------------------------
// Whole-round optimization -- which foursomes to form from a shortlist.
// ---------------------------------------------------------------------------

// Partition `shortlist` into floor(shortlist.length / 4) foursomes, trying to
// minimize (by the tiered comparator) the combined metrics of every foursome's
// best split. This is what lets the generator evaluate "the best 3 matches
// together" instead of "court 1's best match, then court 2's best match from
// whoever's left" (see the module doc comment). Two bounded phases:
//   1. Greedy construction: repeatedly take the highest-priority remaining
//      player and pick whichever 3 remaining players form the best-metrics
//      foursome. With a shortlist capped at ~20-24 players, trying every
//      combination of 3 from what's left is only a few hundred to a thousand
//      checks per pick -- trivial.
//   2. Local improvement: repeatedly try swapping one player between two
//      groups (or a group and a leftover bench player) if it improves their
//      combined metrics (see `addMetrics`), up to a fixed number of passes.
//      Standard bounded local search (akin to 2-opt) -- polynomial in the
//      (small) number of groups, not combinatorial in the pool.
function optimizeRound(shortlist: PlayerForMatchmaking[], history: PairHistory, now: number): PlayerForMatchmaking[][] {
  const groupCount = Math.floor(shortlist.length / 4);
  if (groupCount === 0) return [];

  const metricsOfGroup = (four: PlayerForMatchmaking[]) => bestSplit(four, history, now).metrics;

  const remaining = sortByPriority(shortlist);
  const groups: PlayerForMatchmaking[][] = [];

  while (groups.length < groupCount) {
    const anchor = remaining.shift();
    if (!anchor) break;
    let best: { players: PlayerForMatchmaking[]; metrics: MatchMetrics } | null = null;
    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        for (let k = j + 1; k < remaining.length; k++) {
          const four = [anchor, remaining[i], remaining[j], remaining[k]];
          const metrics = metricsOfGroup(four);
          if (!best || compareMetrics(metrics, best.metrics) < 0) {
            best = { players: [remaining[i], remaining[j], remaining[k]], metrics };
          }
        }
      }
    }
    if (!best) {
      remaining.unshift(anchor);
      break;
    }
    groups.push([anchor, ...best.players]);
    for (const p of best.players) {
      const idx = remaining.indexOf(p);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }

  // `remaining` is now the bench: leftover players who didn't fit into a full
  // foursome this round (shortlist.length wasn't a multiple of 4), available as
  // swap candidates below but not placed into a match.
  const bench = remaining;
  const pairMetrics = (gi: number, gj: number) => addMetrics(metricsOfGroup(groups[gi]), metricsOfGroup(groups[gj]));

  const MAX_PASSES = 300;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false;

    outer: for (let gi = 0; gi < groups.length; gi++) {
      for (let pi = 0; pi < groups[gi].length; pi++) {
        for (let gj = gi + 1; gj < groups.length; gj++) {
          for (let pj = 0; pj < groups[gj].length; pj++) {
            const before = pairMetrics(gi, gj);
            const a = groups[gi][pi];
            const b = groups[gj][pj];
            groups[gi][pi] = b;
            groups[gj][pj] = a;
            const after = pairMetrics(gi, gj);
            if (compareMetrics(after, before) < 0) {
              improved = true;
              break outer;
            }
            groups[gi][pi] = a;
            groups[gj][pj] = b;
          }
        }
        for (let bi = 0; bi < bench.length; bi++) {
          const before = metricsOfGroup(groups[gi]);
          const a = groups[gi][pi];
          groups[gi][pi] = bench[bi];
          const after = metricsOfGroup(groups[gi]);
          if (compareMetrics(after, before) < 0) {
            bench[bi] = a;
            improved = true;
            break outer;
          }
          groups[gi][pi] = a;
        }
      }
    }

    if (!improved) break;
  }

  return groups;
}

export interface SuggestedMatch {
  team1: PlayerForMatchmaking[];
  team2: PlayerForMatchmaking[];
}

function groupKey(ids: number[]): string {
  return [...ids].sort((x, y) => x - y).join(",");
}

function pairKey(team1: PlayerForMatchmaking[], team2: PlayerForMatchmaking[]): string {
  const t1 = team1
    .map((p) => p.id)
    .sort((x, y) => x - y)
    .join("-");
  const t2 = team2
    .map((p) => p.id)
    .sort((x, y) => x - y)
    .join("-");
  return [t1, t2].sort().join("|");
}

// Build up to `count` distinct suggested matchups from the eligible pool, jointly
// optimizing roughly a round's worth of courts at a time rather than picking each
// match independently (see the module doc comment). Players who've played the
// fewest games / rested longest are favored first. When the pool is too small to
// form that many distinct groups of 4, the remaining pairings for groups already
// used are offered instead, so even a very small club still gets a few genuinely
// different options rather than just one.
//
// This is the "balanced" tier of generateSuggestedMatches below -- see that
// function's doc comment for why it's only half the story.
function generateBalancedMatches(
  pool: PlayerForMatchmaking[],
  history: PairHistory,
  count: number,
  courtCount: number,
  now: number,
): SuggestedMatch[] {
  if (pool.length < 4) return [];
  const ranked = sortByPriority(pool);

  // One "round" is roughly courtCount matches worth of players, plus a little
  // slack so the optimizer has room to trade off rest/repeat nudges -- capped so
  // this stays bounded regardless of how large the pool is (see perf note above).
  const shortlistCap = Math.max(4, courtCount) * 4 + 8;

  const allGroups: PlayerForMatchmaking[][] = [];
  const seenGroupKeys = new Set<string>();
  let remainingPool = ranked;

  while (remainingPool.length >= 4 && allGroups.length < count) {
    const shortlist = remainingPool.slice(0, Math.min(remainingPool.length, shortlistCap));
    const groups = optimizeRound(shortlist, history, now);
    if (groups.length === 0) break;

    let addedAny = false;
    for (const four of groups) {
      const key = groupKey(four.map((p) => p.id));
      if (seenGroupKeys.has(key)) continue;
      seenGroupKeys.add(key);
      allGroups.push(four);
      addedAny = true;
    }

    const usedIds = new Set(groups.flat().map((p) => p.id));
    const nextPool = remainingPool.filter((p) => !usedIds.has(p.id));
    if (!addedAny || nextPool.length === remainingPool.length) break;
    remainingPool = nextPool;
  }

  // Best (most-preferred) group first, so a tight suggestion budget still favors
  // the strongest matchups available.
  const rankedGroups = allGroups
    .map((four) => ({ four, split: bestSplit(four, history, now) }))
    .sort((x, y) => compareMetrics(x.split.metrics, y.split.metrics));

  const suggestions: SuggestedMatch[] = [];
  const usedPairKeys = new Set<string>();

  // Pass 1: the single best split for each distinct group.
  for (const { split } of rankedGroups) {
    if (suggestions.length >= count) break;
    const key = pairKey(split.team1, split.team2);
    if (usedPairKeys.has(key)) continue;
    usedPairKeys.add(key);
    suggestions.push({ team1: split.team1, team2: split.team2 });
  }

  // Pass 2 (small pools only): offer the remaining splits for groups already
  // used, so a tiny active roster still yields a few real alternatives.
  if (suggestions.length < count) {
    for (const four of allGroups) {
      if (suggestions.length >= count) break;
      for (const split of allSplitsRanked(four, history, now)) {
        if (suggestions.length >= count) break;
        const key = pairKey(split.team1, split.team2);
        if (usedPairKeys.has(key)) continue;
        usedPairKeys.add(key);
        suggestions.push({ team1: split.team1, team2: split.team2 });
      }
    }
  }

  return suggestions;
}

// Plain, skill-blind foursomes that specifically sweep up whoever
// generateBalancedMatches above didn't cover at all (`coveredIds` -- every
// player who appears in at least one balanced-tier suggestion). Those
// uncovered players are put at the very FRONT of the priority queue, ahead of
// everyone the balanced tier already placed, so they land in the first chunk
// of 4 rather than risking being the trailing remainder yet again -- borrowing
// whichever already-covered players are needed to round a chunk out to 4 (see
// the module doc comment: sharing a player across several suggestions is
// normal here, since only one suggestion actually gets picked).
//
// This is the "fairness" tier of generateSuggestedMatches below, and it
// exists to rescue a player generateBalancedMatches can structurally strand.
// Picture a pool that's almost all one skill level with a single outlier
// (say, eleven "Chick"-level players and one lone "Roast"): optimizeRound's
// greedy construction always prefers filling a foursome with same-level
// players when enough are available (it minimizes skill spread), and its
// local-improvement pass only ever swaps a bench player INTO a group if doing
// so improves that group's metrics -- which swapping in the one differently-
// leveled player never does next to an otherwise-uniform trio. If the pool
// size isn't an exact multiple of 4, that outlier can end up as the sole
// leftover "bench" player for a whole round, which then falls through to the
// next round unchanged -- and if what's left ever drops below 4 players,
// they're never placed in any group again, so they silently never appear in a
// single suggested match. Simply re-sorting the whole pool by priority and
// chunking front-to-back (without the uncovered-first reordering) would
// reproduce that same trailing-remainder problem one level up instead of
// fixing it -- it's specifically the "uncovered players go first" step that
// guarantees they land inside a chunk rather than past the end of one.
function generateFairnessMatches(
  pool: PlayerForMatchmaking[],
  coveredIds: Set<number>,
  history: PairHistory,
  count: number,
  usedPairKeys: Set<string>,
  now: number,
): SuggestedMatch[] {
  if (count <= 0 || pool.length < 4) return [];
  const ranked = sortByPriority(pool);
  const uncovered = ranked.filter((p) => !coveredIds.has(p.id));
  const alreadyCovered = ranked.filter((p) => coveredIds.has(p.id));
  const queue = [...uncovered, ...alreadyCovered];

  const suggestions: SuggestedMatch[] = [];
  for (let i = 0; i + 4 <= queue.length && suggestions.length < count; i += 4) {
    const four = queue.slice(i, i + 4);
    const split = bestSplit(four, history, now);
    const key = pairKey(split.team1, split.team2);
    if (usedPairKeys.has(key)) continue;
    usedPairKeys.add(key);
    suggestions.push({ team1: split.team1, team2: split.team2 });
  }

  return suggestions;
}

// The public entry point: builds up to `count` suggested matchups, tiered
// across two different strategies rather than one. The top half of the
// budget is `generateBalancedMatches` -- skill-matched, round-optimized. The
// bottom half is `generateFairnessMatches` -- plain priority order, no joint
// skill-optimization at all. The second tier exists specifically so a skill
// outlier the balanced pass alone can permanently strand (see
// generateFairnessMatches's doc comment) still gets suggested a match, and
// more generally so whoever's played the fewest games always shows up
// *somewhere* in the queue even when the balanced pass's skill-matching logic
// would otherwise skip over them. A 4-suggestion budget becomes "2 balanced +
// 2 fairness"; the real 8-suggestion default becomes "4 + 4". If the balanced
// tier can't fill its own half (a small pool), the fairness tier picks up the
// slack rather than leaving the budget unused.
//
// `history` is this session's partner/opponent/group counts and "who just
// played" (see PairHistory) -- pass `EMPTY_HISTORY` when there's no completed-
// match history yet (a session's very first suggestions). `now` is the
// reference time for wait-priority (defaults to the real current time; tests
// pass a fixed value for reproducibility).
export function generateSuggestedMatches(
  pool: PlayerForMatchmaking[],
  history: PairHistory,
  count = 8,
  courtCount = 3,
  now: number = Date.now(),
): SuggestedMatch[] {
  if (pool.length < 4) return [];

  const balancedBudget = Math.ceil(count / 2);
  const balanced = generateBalancedMatches(pool, history, balancedBudget, courtCount, now);

  const coveredIds = new Set(balanced.flatMap((m) => [...m.team1, ...m.team2]).map((p) => p.id));
  const usedPairKeys = new Set(balanced.map((m) => pairKey(m.team1, m.team2)));
  const fairness = generateFairnessMatches(pool, coveredIds, history, count - balanced.length, usedPairKeys, now);

  return [...balanced, ...fairness];
}

// ---------------------------------------------------------------------------
// Custom-match balancing -- autofill for the host's manual match builder.
// ---------------------------------------------------------------------------

// Every k-sized combination of `items`, as a plain array of arrays. Only ever
// called with k <= 4 (completeBalancedMatch below never needs more than 4
// players to fill in), so this stays cheap even though it isn't written for
// huge inputs.
function combinations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k > items.length) return [];
  const [first, ...rest] = items;
  const withFirst = combinations(rest, k - 1).map((c) => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

// Given however many players the host has already picked for each team (0-2
// apiece) in the custom-match builder, choose whichever additional players
// from `candidates` best balance the finished 2v2 match by skill level --
// the same spread + distance + team-balance cost matchQuality grades a match
// with. Deliberately leaves the host's own picks exactly on the team they put
// them on: this only ever fills in the empty slots, it never reassigns an
// already-chosen player to the other team (unlike bestSplit, which is free to
// repick any of the 3 splits of a fixed foursome -- that's the right thing for
// a from-scratch suggestion, but not for a host who deliberately placed
// someone on "Team 1"). Returns null when there's nothing to fill (both teams
// already have 2) or not enough candidates to fill what's missing.
//
// This doesn't have session history (partner/opponent counts, rest) to work
// with -- only the levels of whoever's available -- which matches how the
// custom-match builder has always worked (see this module's design brief,
// Priority 3: "for guests, missing ratings, or uncalibrated registered
// players, use the available skill-level data and a safe fallback"). Nothing
// is created or sent anywhere until the host presses the builder's own "Add
// to queue" button, same as any other custom match, so brute-forcing every
// combination is fine -- a single session's eligible pool is small enough
// (tens of players, not thousands) that even choosing all 4 from scratch is
// instant.
export function completeBalancedMatch(
  filledTeam1: PlayerForMatchmaking[],
  filledTeam2: PlayerForMatchmaking[],
  candidates: PlayerForMatchmaking[],
): { team1: PlayerForMatchmaking[]; team2: PlayerForMatchmaking[] } | null {
  const need1 = 2 - filledTeam1.length;
  const need2 = 2 - filledTeam2.length;
  if (need1 < 0 || need2 < 0) return null;
  const totalNeed = need1 + need2;
  if (totalNeed === 0 || candidates.length < totalNeed) return null;

  let best: { team1: PlayerForMatchmaking[]; team2: PlayerForMatchmaking[]; cost: number } | null = null;

  for (const combo of combinations(candidates, totalNeed)) {
    for (const team1Picks of combinations(combo, need1)) {
      const team2Picks = combo.filter((p) => !team1Picks.includes(p));
      if (team2Picks.length !== need2) continue;
      const team1 = [...filledTeam1, ...team1Picks];
      const team2 = [...filledTeam2, ...team2Picks];
      const cost = matchQuality([team1[0].level, team1[1].level], [team2[0].level, team2[1].level]).cost;
      if (!best || cost < best.cost) best = { team1, team2, cost };
    }
  }

  return best ? { team1: best.team1, team2: best.team2 } : null;
}
