// Shared badminton doubles matchmaking logic.
// Pure functions operating on plain player objects so they're easy to reason about
// and reuse -- from the suggestion-generation flow in regenerate.ts (the Worker),
// and directly from the host UI (src/pages/HostSession.tsx) to display a quality
// grade for a match using the exact same cost formula the generator used to pick
// it. This file still has zero imports and no I/O, which is what makes sharing it
// between the two safe (see matchQuality()'s doc comment below for more).
//
// --- How match selection works, in one pass ---
// 1. `generateSuggestedMatches` is the public entry point, and it's tiered: the
//    top half of the budget comes from `generateBalancedMatches` (the
//    skill-matched optimizer described below), the bottom half from
//    `generateFairnessMatches` (plain priority order, no skill-balancing at
//    all). See generateSuggestedMatches's own doc comment for why a single
//    skill-balanced pass isn't enough on its own.
// 2. `generateBalancedMatches` sorts the eligible pool by priority (fewest games
//    played, then longest rest -- sortByPriority), then repeatedly carves off a
//    bounded "shortlist" (roughly one round's worth of courts, plus a little
//    slack) and asks `optimizeRound` to jointly partition it into foursomes that
//    minimize total cost -- not "best match for court 1, then best match for
//    court 2", which can strand weaker players for the later courts (see the
//    module's section-4 requirement in the originating spec). This repeats,
//    round after round, until enough distinct groups exist to fill its budget
//    of suggestions or the pool runs out.
// 3. For each foursome, `allSplitsRanked` tries all 3 ways to split it into two
//    teams of two and scores each by team balance + rest/repeat/preference
//    nudges, picking the cheapest. `generateFairnessMatches` reuses this same
//    per-foursome split logic (via bestSplitAvoidingRepeats) -- only how the
//    foursomes themselves get formed differs between the two tiers.
// 4. `matchQuality` grades a finished team1-vs-team2 split using only the
//    players' levels (skill spread + team balance) -- deliberately independent of
//    rest/history, since a grade should describe the match itself, not how it was
//    chosen. The same spread+balance formula is also the dominant term inside the
//    selection cost above, so the grade always reflects why a match looks the way
//    it does.
//
// --- Performance ---
// The shortlist handed to `optimizeRound` is capped (roughly one round's worth of
// courts + 8 spare players), so even a 30-player/3-court session only ever
// jointly optimizes ~20 players at a time -- bounded greedy construction
// (O(shortlist^3) for the worst single pick, trivial at this size) followed by a
// capped number of pairwise-swap improvement passes. No step scans anywhere close
// to all permutations of the full pool.

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
// AGENTS.md: letters are what's shown everywhere in the UI/API).
const LEVEL_SCORE: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, E: 1 };

function levelScore(level: string): number {
  return LEVEL_SCORE[level] ?? 3;
}

// Sort the eligible pool by matchmaking priority: fewest games played first, then
// longest time since their last match ended (nulls = never played = highest
// priority). This is also what keeps someone who just finished a match from being
// suggested again right away, whenever there's anyone else to rotate in instead.
export function sortByPriority(pool: PlayerForMatchmaking[]): PlayerForMatchmaking[] {
  return [...pool].sort((a, b) => {
    if (a.gamesPlayed !== b.gamesPlayed) return a.gamesPlayed - b.gamesPlayed;
    const aTime = a.lastMatchEndedAt ? new Date(a.lastMatchEndedAt).getTime() : 0;
    const bTime = b.lastMatchEndedAt ? new Date(b.lastMatchEndedAt).getTime() : 0;
    return aTime - bTime;
  });
}

// ---------------------------------------------------------------------------
// Quality grade -- a pure function of the four players' levels only.
// ---------------------------------------------------------------------------

export type MatchGrade = "excellent" | "good" | "fair" | "uneven" | "poor";

export interface MatchQuality {
  grade: MatchGrade;
  emoji: string;
  label: string;
  // The same skill-spread + team-balance cost the selection algorithm below
  // computes for this exact split -- exposed so the grade's "why" can be
  // inspected/tested, not just the bucketed label.
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
// (priority 1 in the spec this was built from: "players close in skill level"),
// team balance is secondary (priority 2), and the variance term is a small
// tie-breaker so e.g. "A+D vs A+D" (a bimodal, two-extreme group) is graded worse
// than "A+C vs B+D" (a more evenly-spread group) even though both have the same
// highest-lowest gap -- see the worked examples in the project's matchmaking
// design notes for why max-min alone can't tell those apart.
const SPREAD_WEIGHT = 4;
const VARIANCE_WEIGHT = 1;
const BALANCE_WEIGHT = 1;

function skillBalanceCost(team1Levels: [string, string], team2Levels: [string, string]): number {
  const four = [team1Levels[0], team1Levels[1], team2Levels[0], team2Levels[1]].map(levelScore);
  const spread = Math.max(...four) - Math.min(...four);
  const mean = four.reduce((a, b) => a + b, 0) / 4;
  const variance = four.reduce((sum, v) => sum + (v - mean) ** 2, 0) / 4;
  const team1Sum = levelScore(team1Levels[0]) + levelScore(team1Levels[1]);
  const team2Sum = levelScore(team2Levels[0]) + levelScore(team2Levels[1]);
  const imbalance = Math.abs(team1Sum - team2Sum);
  return SPREAD_WEIGHT * spread + VARIANCE_WEIGHT * variance + BALANCE_WEIGHT * imbalance;
}

// Grade thresholds chosen so each one-level step in spread (holding balance
// equal) lands in its own tier: 0 -> excellent, 1 -> good, 2 -> fair, 3 ->
// uneven, 4 (the A-vs-E extreme) -> poor, with a little headroom in each bucket
// for the balance/variance nudge.
export function matchQuality(team1Levels: [string, string], team2Levels: [string, string]): MatchQuality {
  const cost = skillBalanceCost(team1Levels, team2Levels);
  let grade: MatchGrade;
  if (cost <= 2) grade = "excellent";
  else if (cost <= 6) grade = "good";
  else if (cost <= 10) grade = "fair";
  else if (cost <= 14) grade = "uneven";
  else grade = "poor";
  return { grade, cost, ...GRADE_INFO[grade] };
}

// ---------------------------------------------------------------------------
// Split selection -- given a fixed foursome, which 2v2 split is best.
// ---------------------------------------------------------------------------

export interface SuggestedSplit {
  team1: [PlayerForMatchmaking, PlayerForMatchmaking];
  team2: [PlayerForMatchmaking, PlayerForMatchmaking];
}

// Extra "cost" added when a pairing would repeat either player's most recent
// partner or opponent, and a "discount" applied when a pairing matches either
// player's stated preferred partner -- sized so the generator leans that way
// without overriding a much better-balanced alternative (lowest priority in the
// spec this was built from: "avoid unnecessary repeated pairings/opponents, only
// when this does not significantly worsen the matchup").
const REPEAT_PARTNER_PENALTY = 2.5;
const REPEAT_OPPONENT_PENALTY = 1;
const PREFERRED_PARTNER_BONUS = 2.5;

// How much a player's rest/rotation priority (0 = most deserving of a game right
// now, 1 = least) counts against a group that includes them. Deliberately small
// relative to SPREAD_WEIGHT/BALANCE_WEIGHT -- rest is priority 3 in the spec,
// behind skill similarity and team balance, so it should only tip the balance
// between otherwise-close options, never justify a lopsided match.
const REST_WEIGHT = 1.5;

function preferredTogether(a: PlayerForMatchmaking, b: PlayerForMatchmaking): boolean {
  return a.preferredPartnerId === b.id || b.preferredPartnerId === a.id;
}

// The part of a foursome's cost that doesn't depend on how it's split into
// teams: skill spread + distribution (variance) across all 4, plus how
// deserving of a game (rested/under-played) this specific group of 4 is.
function groupCost(four: PlayerForMatchmaking[], restRankOf: Map<number, number>): number {
  const levels = four.map((p) => levelScore(p.level));
  const spread = Math.max(...levels) - Math.min(...levels);
  const mean = levels.reduce((a, b) => a + b, 0) / 4;
  const variance = levels.reduce((sum, v) => sum + (v - mean) ** 2, 0) / 4;
  const rest = four.reduce((sum, p) => sum + (restRankOf.get(p.id) ?? 0), 0);
  return SPREAD_WEIGHT * spread + VARIANCE_WEIGHT * variance + REST_WEIGHT * rest;
}

// All 3 ways to split 4 players into two teams, ranked best (lowest total cost)
// to worst. `base` (the group-level skill-spread/variance/rest cost) is the same
// for every split of this same foursome, so it doesn't affect which split wins
// here -- it matters when *comparing different foursomes* against each other in
// optimizeRound below.
function allSplitsRanked(
  four: PlayerForMatchmaking[],
  lastPartnerOf: Map<number, number>,
  lastOpponentOf: Map<number, number>,
  restRankOf: Map<number, number>,
): (SuggestedSplit & { cost: number })[] {
  const [a, b, c, d] = four;
  const options: [[PlayerForMatchmaking, PlayerForMatchmaking], [PlayerForMatchmaking, PlayerForMatchmaking]][] = [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
  const base = groupCost(four, restRankOf);
  return options
    .map(([team1, team2]) => {
      const team1Sum = levelScore(team1[0].level) + levelScore(team1[1].level);
      const team2Sum = levelScore(team2[0].level) + levelScore(team2[1].level);
      const imbalance = Math.abs(team1Sum - team2Sum);
      const repeatPartners =
        (lastPartnerOf.get(team1[0].id) === team1[1].id ? 1 : 0) +
        (lastPartnerOf.get(team2[0].id) === team2[1].id ? 1 : 0);
      const repeatOpponents = [team1[0], team1[1]].reduce((n, p) => {
        const opp = lastOpponentOf.get(p.id);
        return n + (opp != null && (team2[0].id === opp || team2[1].id === opp) ? 1 : 0);
      }, 0);
      const preferred =
        (preferredTogether(team1[0], team1[1]) ? 1 : 0) + (preferredTogether(team2[0], team2[1]) ? 1 : 0);
      const cost =
        base +
        BALANCE_WEIGHT * imbalance +
        REPEAT_PARTNER_PENALTY * repeatPartners +
        REPEAT_OPPONENT_PENALTY * repeatOpponents -
        PREFERRED_PARTNER_BONUS * preferred;
      return { team1, team2, cost };
    })
    .sort((x, y) => x.cost - y.cost);
}

// Given exactly 4 players, find the 2v2 split that best balances skill while
// favoring stated partner preferences and avoiding either player's most recent
// partner/opponent.
export function bestSplitAvoidingRepeats(
  four: PlayerForMatchmaking[],
  lastPartnerOf: Map<number, number>,
  lastOpponentOf: Map<number, number> = new Map(),
  restRankOf: Map<number, number> = new Map(),
): SuggestedSplit {
  const { team1, team2 } = allSplitsRanked(four, lastPartnerOf, lastOpponentOf, restRankOf)[0];
  return { team1, team2 };
}

// ---------------------------------------------------------------------------
// Whole-round optimization -- which foursomes to form from a shortlist.
// ---------------------------------------------------------------------------

// Partition `shortlist` into floor(shortlist.length / 4) foursomes, trying to
// minimize the sum of every foursome's best-split cost. This is what lets the
// generator evaluate "the best 3 matches together" instead of "court 1's best
// match, then court 2's best match from whoever's left" (see the module doc
// comment). Two bounded phases:
//   1. Greedy construction: repeatedly take the highest-priority remaining
//      player and pick whichever 3 remaining players minimize their combined
//      foursome cost. With a shortlist capped at ~20-24 players, trying every
//      combination of 3 from what's left is only a few hundred to a thousand
//      checks per pick -- trivial.
//   2. Local improvement: repeatedly try swapping one player between two groups
//      (or a group and a leftover bench player) if it lowers total cost, up to a
//      fixed number of passes. Standard bounded local search (akin to 2-opt) --
//      polynomial in the (small) number of groups, not combinatorial in the pool.
function optimizeRound(
  shortlist: PlayerForMatchmaking[],
  lastPartnerOf: Map<number, number>,
  lastOpponentOf: Map<number, number>,
  restRankOf: Map<number, number>,
): PlayerForMatchmaking[][] {
  const groupCount = Math.floor(shortlist.length / 4);
  if (groupCount === 0) return [];

  const costOf = (four: PlayerForMatchmaking[]) =>
    allSplitsRanked(four, lastPartnerOf, lastOpponentOf, restRankOf)[0].cost;

  const remaining = sortByPriority(shortlist);
  const groups: PlayerForMatchmaking[][] = [];

  while (groups.length < groupCount) {
    const anchor = remaining.shift();
    if (!anchor) break;
    let best: { players: PlayerForMatchmaking[]; cost: number } | null = null;
    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        for (let k = j + 1; k < remaining.length; k++) {
          const four = [anchor, remaining[i], remaining[j], remaining[k]];
          const cost = costOf(four);
          if (!best || cost < best.cost) best = { players: [remaining[i], remaining[j], remaining[k]], cost };
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
  const pairCost = (gi: number, gj: number) => costOf(groups[gi]) + costOf(groups[gj]);

  const MAX_PASSES = 300;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false;

    outer: for (let gi = 0; gi < groups.length; gi++) {
      for (let pi = 0; pi < groups[gi].length; pi++) {
        for (let gj = gi + 1; gj < groups.length; gj++) {
          for (let pj = 0; pj < groups[gj].length; pj++) {
            const before = pairCost(gi, gj);
            const a = groups[gi][pi];
            const b = groups[gj][pj];
            groups[gi][pi] = b;
            groups[gj][pj] = a;
            const after = pairCost(gi, gj);
            if (after < before - 1e-9) {
              improved = true;
              break outer;
            }
            groups[gi][pi] = a;
            groups[gj][pj] = b;
          }
        }
        for (let bi = 0; bi < bench.length; bi++) {
          const before = costOf(groups[gi]);
          const a = groups[gi][pi];
          groups[gi][pi] = bench[bi];
          const after = costOf(groups[gi]);
          if (after < before - 1e-9) {
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

function groupKey(four: PlayerForMatchmaking[]): string {
  return four
    .map((p) => p.id)
    .sort((x, y) => x - y)
    .join(",");
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
  lastPartnerOf: Map<number, number>,
  count: number,
  courtCount: number,
  lastOpponentOf: Map<number, number>,
): SuggestedMatch[] {
  if (pool.length < 4) return [];
  const ranked = sortByPriority(pool);

  // Each player's rest/rotation priority, normalized to [0, 1] across the whole
  // eligible pool (0 = most deserving of a game right now).
  const restRankOf = new Map<number, number>();
  ranked.forEach((p, i) => restRankOf.set(p.id, ranked.length > 1 ? i / (ranked.length - 1) : 0));

  // One "round" is roughly courtCount matches worth of players, plus a little
  // slack so the optimizer has room to trade off rest/repeat nudges -- capped so
  // this stays bounded regardless of how large the pool is (see perf note above).
  const shortlistCap = Math.max(4, courtCount) * 4 + 8;

  const allGroups: PlayerForMatchmaking[][] = [];
  const seenGroupKeys = new Set<string>();
  let remainingPool = ranked;

  while (remainingPool.length >= 4 && allGroups.length < count) {
    const shortlist = remainingPool.slice(0, Math.min(remainingPool.length, shortlistCap));
    const groups = optimizeRound(shortlist, lastPartnerOf, lastOpponentOf, restRankOf);
    if (groups.length === 0) break;

    let addedAny = false;
    for (const four of groups) {
      const key = groupKey(four);
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

  // Best (lowest-cost) group first, so a tight suggestion budget still favors the
  // strongest matchups available.
  const rankedGroups = allGroups
    .map((four) => ({ four, split: allSplitsRanked(four, lastPartnerOf, lastOpponentOf, restRankOf)[0] }))
    .sort((x, y) => x.split.cost - y.split.cost);

  const suggestions: SuggestedMatch[] = [];
  const usedPairKeys = new Set<string>();

  // Pass 1: the single best-balanced split for each distinct group.
  for (const { split } of rankedGroups) {
    if (suggestions.length >= count) break;
    const key = pairKey(split.team1, split.team2);
    if (usedPairKeys.has(key)) continue;
    usedPairKeys.add(key);
    suggestions.push({ team1: split.team1, team2: split.team2 });
  }

  // Pass 2 (small pools only): offer the remaining pairings for groups already
  // used, so a tiny active roster still yields a few real alternatives.
  if (suggestions.length < count) {
    for (const four of allGroups) {
      if (suggestions.length >= count) break;
      for (const split of allSplitsRanked(four, lastPartnerOf, lastOpponentOf, restRankOf)) {
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
// so lowers that group's cost -- which swapping in the one differently-leveled
// player never does next to an otherwise-uniform trio. If the pool size isn't
// an exact multiple of 4, that outlier can end up as the sole leftover "bench"
// player for a whole round, which then falls through to the next round
// unchanged -- and if what's left ever drops below 4 players, they're never
// placed in any group again, so they silently never appear in a single
// suggested match. Simply re-sorting the whole pool by priority and chunking
// front-to-back (without the uncovered-first reordering) would reproduce that
// same trailing-remainder problem one level up instead of fixing it -- it's
// specifically the "uncovered players go first" step that guarantees they
// land inside a chunk rather than past the end of one.
function generateFairnessMatches(
  pool: PlayerForMatchmaking[],
  coveredIds: Set<number>,
  lastPartnerOf: Map<number, number>,
  lastOpponentOf: Map<number, number>,
  count: number,
  usedPairKeys: Set<string>,
): SuggestedMatch[] {
  if (count <= 0 || pool.length < 4) return [];
  const ranked = sortByPriority(pool);
  const uncovered = ranked.filter((p) => !coveredIds.has(p.id));
  const alreadyCovered = ranked.filter((p) => coveredIds.has(p.id));
  const queue = [...uncovered, ...alreadyCovered];

  const suggestions: SuggestedMatch[] = [];
  for (let i = 0; i + 4 <= queue.length && suggestions.length < count; i += 4) {
    const four = queue.slice(i, i + 4);
    const split = bestSplitAvoidingRepeats(four, lastPartnerOf, lastOpponentOf);
    const key = pairKey(split.team1, split.team2);
    if (usedPairKeys.has(key)) continue;
    usedPairKeys.add(key);
    suggestions.push({ team1: split.team1, team2: split.team2 });
  }

  return suggestions;
}

// The public entry point: builds up to `count` suggested matchups, tiered
// across two different strategies rather than one. The top half of the
// budget is `generateBalancedMatches` -- skill-matched, round-optimized,
// unchanged from how this always worked. The bottom half is
// `generateFairnessMatches` -- plain priority order, no skill-balancing at
// all. The second tier exists specifically so a skill outlier the balanced
// pass alone can permanently strand (see generateFairnessMatches's doc
// comment) still gets suggested a match, and more generally so whoever's
// played the fewest games always shows up *somewhere* in the queue even when
// the balanced pass's skill-matching logic would otherwise skip over them. A
// 4-suggestion budget becomes "2 balanced + 2 fairness"; the real 8-suggestion
// default becomes "4 + 4". If the balanced tier can't fill its own half (a
// small pool), the fairness tier picks up the slack rather than leaving the
// budget unused.
export function generateSuggestedMatches(
  pool: PlayerForMatchmaking[],
  lastPartnerOf: Map<number, number>,
  count = 8,
  courtCount = 3,
  lastOpponentOf: Map<number, number> = new Map(),
): SuggestedMatch[] {
  if (pool.length < 4) return [];

  const balancedBudget = Math.ceil(count / 2);
  const balanced = generateBalancedMatches(pool, lastPartnerOf, balancedBudget, courtCount, lastOpponentOf);

  const coveredIds = new Set(balanced.flatMap((m) => [...m.team1, ...m.team2]).map((p) => p.id));
  const usedPairKeys = new Set(balanced.map((m) => pairKey(m.team1, m.team2)));
  const fairness = generateFairnessMatches(
    pool,
    coveredIds,
    lastPartnerOf,
    lastOpponentOf,
    count - balanced.length,
    usedPairKeys,
  );

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
// the same spread + team-balance cost matchQuality grades a match with.
// Deliberately leaves the host's own picks exactly on the team they put them
// on: this only ever fills in the empty slots, it never reassigns an
// already-chosen player to the other team (unlike bestSplitAvoidingRepeats,
// which is free to repick any of the 3 splits of a fixed foursome -- that's
// the right thing for a from-scratch suggestion, but not for a host who
// deliberately placed someone on "Team 1"). Returns null when there's
// nothing to fill (both teams already have 2) or not enough candidates to
// fill what's missing.
//
// This is a pure autofill: nothing is created or sent anywhere until the
// host presses the builder's own "Add to queue" button, same as any other
// custom match, so brute-forcing every combination is fine -- a single
// session's eligible pool is small enough (tens of players, not thousands)
// that even choosing all 4 from scratch is instant.
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
