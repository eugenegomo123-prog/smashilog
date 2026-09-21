// Shared badminton doubles matchmaking logic.
// Pure functions operating on plain player objects so they can be reused by
// both the queue-projection endpoint and the match-generation endpoint.

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

// Sort the eligible pool by matchmaking priority: fewest games played first,
// then longest time since their last match ended (nulls = never played = highest priority).
export function sortByPriority(pool: PlayerForMatchmaking[]): PlayerForMatchmaking[] {
  return [...pool].sort((a, b) => {
    if (a.gamesPlayed !== b.gamesPlayed) return a.gamesPlayed - b.gamesPlayed;
    const aTime = a.lastMatchEndedAt ? new Date(a.lastMatchEndedAt).getTime() : 0;
    const bTime = b.lastMatchEndedAt ? new Date(b.lastMatchEndedAt).getTime() : 0;
    return aTime - bTime;
  });
}

export interface TeamSplit {
  team1: [PlayerForMatchmaking, PlayerForMatchmaking];
  team2: [PlayerForMatchmaking, PlayerForMatchmaking];
  gap: number;
}

// Given exactly 4 players, find the 2v2 split that minimizes the rating gap.
export function bestSplit(four: PlayerForMatchmaking[]): TeamSplit {
  const [a, b, c, d] = four;
  const options: [[PlayerForMatchmaking, PlayerForMatchmaking], [PlayerForMatchmaking, PlayerForMatchmaking]][] = [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
  let best: TeamSplit | null = null;
  for (const [team1, team2] of options) {
    const gap = Math.abs(
      (ratingFor(team1[0]) + ratingFor(team1[1])) - (ratingFor(team2[0]) + ratingFor(team2[1])),
    );
    if (!best || gap < best.gap) best = { team1, team2, gap };
  }
  return best as TeamSplit;
}

export interface ProjectedMatch {
  team1: PlayerForMatchmaking[];
  team2: PlayerForMatchmaking[];
}

// Simulate pulling from the eligible pool `slotCount` times (once per open court,
// or up to `limit` for the "next in queue" preview), without mutating state.
export function projectMatches(pool: PlayerForMatchmaking[], limit: number): ProjectedMatch[] {
  let remaining = sortByPriority(pool);
  const projected: ProjectedMatch[] = [];
  while (remaining.length >= 4 && projected.length < limit) {
    const four = remaining.slice(0, 4);
    remaining = remaining.slice(4);
    const split = bestSplit(four);
    projected.push({ team1: split.team1, team2: split.team2 });
  }
  return projected;
}
