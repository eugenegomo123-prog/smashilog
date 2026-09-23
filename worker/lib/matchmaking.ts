// Shared badminton doubles matchmaking logic.
// Pure functions operating on plain player objects so they're easy to reason about
// and reuse from the suggestion-generation flow in regenerate.ts.

export interface PlayerForMatchmaking {
  id: number;
  level: string; // A-E
  currentStreak: number;
  pointsFor: number;
  pointsAgainst: number;
  gamesPlayed: number;
  lastMatchEndedAt: string | null;
}

const LEVEL_SCORE: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, E: 1 };

function levelScore(level: string): number {
  return LEVEL_SCORE[level] ?? 3;
}

function ratingFor(p: PlayerForMatchmaking): number {
  const streakAdj = Math.max(-1, Math.min(1, p.currentStreak)) * 0.15;
  const diff = p.pointsFor - p.pointsAgainst;
  const diffAdj = Math.max(-1, Math.min(1, diff / 20)) * 0.1;
  return levelScore(p.level) + streakAdj + diffAdj;
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

export interface SuggestedSplit {
  team1: [PlayerForMatchmaking, PlayerForMatchmaking];
  team2: [PlayerForMatchmaking, PlayerForMatchmaking];
}

// Extra "cost" added when a pairing would repeat either player's most recent
// partner -- big enough that the generator prefers a fresh pairing unless doing
// so would make the match meaningfully less balanced.
const REPEAT_PARTNER_PENALTY = 2.5;

// All 3 ways to split 4 players into two teams, ranked best (lowest skill gap +
// repeat-partner penalty) to worst.
function allSplitsRanked(
  four: PlayerForMatchmaking[],
  lastPartnerOf: Map<number, number>,
): SuggestedSplit[] {
  const [a, b, c, d] = four;
  const options: [[PlayerForMatchmaking, PlayerForMatchmaking], [PlayerForMatchmaking, PlayerForMatchmaking]][] = [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
  return options
    .map(([team1, team2]) => {
      const gap = Math.abs(
        (ratingFor(team1[0]) + ratingFor(team1[1])) - (ratingFor(team2[0]) + ratingFor(team2[1])),
      );
      const repeats =
        (lastPartnerOf.get(team1[0].id) === team1[1].id ? 1 : 0) +
        (lastPartnerOf.get(team2[0].id) === team2[1].id ? 1 : 0);
      return { team1, team2, score: gap + repeats * REPEAT_PARTNER_PENALTY };
    })
    .sort((x, y) => x.score - y.score)
    .map(({ team1, team2 }) => ({ team1, team2 }));
}

// Given exactly 4 players, find the 2v2 split that best balances skill while
// preferring not to repeat either player's most recent partner.
export function bestSplitAvoidingRepeats(
  four: PlayerForMatchmaking[],
  lastPartnerOf: Map<number, number>,
): SuggestedSplit {
  return allSplitsRanked(four, lastPartnerOf)[0];
}

export interface SuggestedMatch {
  team1: PlayerForMatchmaking[];
  team2: PlayerForMatchmaking[];
}

// Build up to `count` distinct suggested matchups from the eligible pool.
// Players who've played the fewest games / rested longest are favored first.
// Different rotations of the priority order are used to spread players across
// different suggestions rather than reusing the same foursome repeatedly. When
// the pool is too small to form that many distinct groups of 4, the remaining
// pairings for groups already used are offered instead, so even a very small
// club still gets a few genuinely different options rather than just one.
export function generateSuggestedMatches(
  pool: PlayerForMatchmaking[],
  lastPartnerOf: Map<number, number>,
  count = 8,
): SuggestedMatch[] {
  if (pool.length < 4) return [];
  const ranked = sortByPriority(pool);

  const groups: PlayerForMatchmaking[][] = [];
  const seenGroups = new Set<string>();
  const maxAttempts = ranked.length * 3;
  let staleRounds = 0;

  for (let rotation = 0; rotation < maxAttempts; rotation++) {
    const offset = rotation % ranked.length;
    const rotated = ranked.slice(offset).concat(ranked.slice(0, offset));
    let formedNew = false;
    for (let i = 0; i + 4 <= rotated.length; i += 4) {
      const four = rotated.slice(i, i + 4);
      const key = four.map((p) => p.id).sort((x, y) => x - y).join(",");
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      groups.push(four);
      formedNew = true;
    }
    staleRounds = formedNew ? 0 : staleRounds + 1;
    if (staleRounds > ranked.length) break;
  }

  function pairKey(team1: PlayerForMatchmaking[], team2: PlayerForMatchmaking[]) {
    const t1 = team1.map((p) => p.id).sort((x, y) => x - y).join("-");
    const t2 = team2.map((p) => p.id).sort((x, y) => x - y).join("-");
    return [t1, t2].sort().join("|");
  }

  const suggestions: SuggestedMatch[] = [];
  const usedPairKeys = new Set<string>();

  // Pass 1: the single best-balanced split for each distinct group of 4.
  for (const four of groups) {
    if (suggestions.length >= count) break;
    const split = bestSplitAvoidingRepeats(four, lastPartnerOf);
    const key = pairKey(split.team1, split.team2);
    if (usedPairKeys.has(key)) continue;
    usedPairKeys.add(key);
    suggestions.push(split);
  }

  // Pass 2 (small pools only): offer the remaining pairings for groups already used,
  // so a tiny active roster still yields a few real alternatives.
  if (suggestions.length < count) {
    for (const four of groups) {
      if (suggestions.length >= count) break;
      for (const split of allSplitsRanked(four, lastPartnerOf)) {
        if (suggestions.length >= count) break;
        const key = pairKey(split.team1, split.team2);
        if (usedPairKeys.has(key)) continue;
        usedPairKeys.add(key);
        suggestions.push(split);
      }
    }
  }

  return suggestions;
}
