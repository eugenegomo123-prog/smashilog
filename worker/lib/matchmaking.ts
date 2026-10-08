// Shared badminton doubles matchmaking logic.
// Pure functions operating on plain player objects so they're easy to reason about
// and reuse -- from the suggestion-generation flow in regenerate.ts (the Worker),
// and directly from the host UI (src/pages/HostSession.tsx) to display a quality
// grade for a match using the exact same cost formula the generator used to pick
// it. This file still has zero imports and no I/O, which is what makes sharing it
// between the two safe (see matchQuality()'s doc comment below for more).
//
// --- How match selection works, in one pass ---
// 1. `generateSuggestedMatches` sorts the eligible pool by priority (fewest games
//    played, then longest rest -- sortByPriority), then repeatedly carves off a
//    bounded "shortlist" (roughly one round's worth of courts, plus a little
//    slack) and asks `optimizeRound` to jointly partition it into foursomes that
//    minimize total cost -- not "best match for court 1, then best match for
//    court 2", which can strand weaker players for the later courts (see the
//    module's section-4 requirement in the originating spec). This repeats,
//    round after round, until enough distinct groups exist to fill `count`
//    suggestions or the pool runs out.
// 2. For each foursome, `allSplitsRanked` tries all 3 ways to split it into two
//    teams of two and scores each by team balance + rest/repeat/preference
//    nudges, picking the cheapest.
// 3. `matchQuality` grades a finished team1-vs-team2 split using only the
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
export function generateSuggestedMatches(
  pool: PlayerForMatchmaking[],
  lastPartnerOf: Map<number, number>,
  count = 8,
  courtCount = 3,
  lastOpponentOf: Map<number, number> = new Map(),
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
