// Unit tests for the matchmaking engine (worker/lib/matchmaking.ts).
//
// These exercise the pure functions directly with fixed inputs, so every
// scenario is deterministic and reproducible -- no database, no network, no
// wall-clock time (a fixed `now` is always passed in). Run with your existing
// test runner (vitest/jest-style `describe`/`it`/`expect` APIs assumed, same
// as worker/lib/rating.test.ts -- adjust the two imports at the top if this
// project uses a different one).
//
// NOTE: at the time this file was added, `vitest` itself was not installed in
// the sandbox used to write it (no package-registry access -- see the repo's
// git history around "Fix deploy failure: remove vitest devDependency" for
// why it isn't a devDependency yet), so these cases were additionally
// verified by hand against the compiled module with a plain Node/assert
// harness. See the completion report for those results. Once a test runner is
// added from an environment with registry access (which also regenerates
// package-lock.json to match), `npm test` should run this file as-is.

import { describe, it, expect } from "vitest";
import {
  generateSuggestedMatches,
  bestSplit,
  matchQuality,
  compareMetrics,
  EMPTY_HISTORY,
  type PlayerForMatchmaking,
  type PairHistory,
  type MatchMetrics,
  type SuggestedMatch,
} from "./matchmaking";

let nextId = 1;
function player(level: string, overrides: Partial<PlayerForMatchmaking> = {}): PlayerForMatchmaking {
  return {
    id: nextId++,
    level,
    currentStreak: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    gamesPlayed: 0,
    lastMatchEndedAt: null,
    preferredPartnerId: null,
    ...overrides,
  };
}

function idsOf(m: SuggestedMatch): Set<number> {
  return new Set([...m.team1, ...m.team2].map((p) => p.id));
}

function levelsOf(m: SuggestedMatch): string[] {
  return [...m.team1, ...m.team2].map((p) => p.level).sort();
}

function suggestionKey(m: SuggestedMatch): string {
  const t1 = m.team1
    .map((p) => p.id)
    .sort((a, b) => a - b)
    .join("-");
  const t2 = m.team2
    .map((p) => p.id)
    .sort((a, b) => a - b)
    .join("-");
  return [t1, t2].sort().join("|");
}

describe("generateSuggestedMatches", () => {
  // Test A -- four identical-level players.
  it("uses all four players and grades them excellent when every level matches", () => {
    nextId = 1;
    const pool = [player("B"), player("B"), player("B"), player("B")];
    const suggestions = generateSuggestedMatches(pool, EMPTY_HISTORY, 8, 1, 1000);
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(idsOf(suggestions[0]).size).toBe(4);
    const q = matchQuality(
      [suggestions[0].team1[0].level, suggestions[0].team1[1].level],
      [suggestions[0].team2[0].level, suggestions[0].team2[1].level],
    );
    expect(q.grade).toBe("excellent");
  });

  // Test B -- same-level candidates vs. a wider-level candidate that waited longer.
  it("prefers a tight skill match over a wider-spread match even when the wider group waited far longer", () => {
    nextId = 1;
    const now = 10_000_000;
    const justPlayed = new Date(now).toISOString();
    const longWait = new Date(now - 10_000_000 * 60_000).toISOString();
    const as = [player("A", { lastMatchEndedAt: justPlayed }), player("A", { lastMatchEndedAt: justPlayed }), player("A", { lastMatchEndedAt: justPlayed }), player("A", { lastMatchEndedAt: justPlayed })];
    const bs = [player("B", { lastMatchEndedAt: longWait }), player("B", { lastMatchEndedAt: longWait })];
    const cs = [player("C", { lastMatchEndedAt: longWait }), player("C", { lastMatchEndedAt: longWait })];
    const suggestions = generateSuggestedMatches([...as, ...bs, ...cs], EMPTY_HISTORY, 8, 2, now);
    expect(levelsOf(suggestions[0])).toEqual(["A", "A", "A", "A"]);
  });

  // Test H -- insufficient players.
  it("returns no suggestions when fewer than 4 players are eligible", () => {
    nextId = 1;
    const pool = [player("C"), player("C"), player("C")];
    expect(generateSuggestedMatches(pool, EMPTY_HISTORY, 8, 2, 1000)).toEqual([]);
  });

  // Test E -- waiting-time fairness.
  it("prioritizes a longer-waiting, less-played group when skill quality is comparable", () => {
    nextId = 1;
    const now = 10_000_000;
    const soon = new Date(now - 60_000).toISOString();
    const long = new Date(now - 1_000_000_000).toISOString();
    const groupRecent = Array.from({ length: 4 }, () => player("C", { lastMatchEndedAt: soon, gamesPlayed: 5 }));
    const groupWaiting = Array.from({ length: 4 }, () => player("C", { lastMatchEndedAt: long, gamesPlayed: 1 }));
    const suggestions = generateSuggestedMatches([...groupRecent, ...groupWaiting], EMPTY_HISTORY, 1, 1, now);
    expect(suggestions.length).toBe(1);
    const ids = idsOf(suggestions[0]);
    for (const p of groupWaiting) expect(ids.has(p.id)).toBe(true);
  });

  // Test F -- consecutive games (just played vs. rested).
  it("favors rested players over a group that just came off a court", () => {
    nextId = 1;
    const now = 10_000_000;
    const justEnded = new Date(now).toISOString();
    const restedEnded = new Date(now - 600_000).toISOString();
    const justFinished = Array.from({ length: 4 }, () => player("C", { gamesPlayed: 2, lastMatchEndedAt: justEnded }));
    const rested = Array.from({ length: 4 }, () => player("C", { gamesPlayed: 2, lastMatchEndedAt: restedEnded }));
    const history: PairHistory = { ...EMPTY_HISTORY, justPlayedIds: new Set(justFinished.map((p) => p.id)) };
    const suggestions = generateSuggestedMatches([...justFinished, ...rested], history, 1, 1, now);
    expect(suggestions.length).toBe(1);
    const ids = idsOf(suggestions[0]);
    for (const p of rested) expect(ids.has(p.id)).toBe(true);
  });

  // Test M -- suggestion uniqueness.
  it("never returns the same 4-player group + team split twice", () => {
    nextId = 1;
    const pool = Array.from({ length: 12 }, (_, i) => player(["A", "B", "C", "D"][i % 4]));
    const suggestions = generateSuggestedMatches(pool, EMPTY_HISTORY, 8, 3, 1000);
    const keys = suggestions.map(suggestionKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // Test N -- tie-breaking stability.
  it("produces identical output across repeated runs with identical inputs", () => {
    nextId = 1;
    const pool = Array.from({ length: 10 }, (_, i) => player(["A", "B", "C"][i % 3], { gamesPlayed: i % 3 }));
    const run1 = generateSuggestedMatches(pool, EMPTY_HISTORY, 8, 2, 5_000_000);
    const run2 = generateSuggestedMatches(pool, EMPTY_HISTORY, 8, 2, 5_000_000);
    expect(run1.map(suggestionKey)).toEqual(run2.map(suggestionKey));
  });
});

describe("bestSplit", () => {
  // Test C -- balanced adjacent levels.
  it("splits A,A,B,B into one A + one B per team rather than stacking", () => {
    nextId = 1;
    const pool = [player("A"), player("A"), player("B"), player("B")];
    const split = bestSplit(pool, EMPTY_HISTORY, 1000);
    expect([...new Set(split.team1.map((p) => p.level))].sort()).toEqual(["A", "B"]);
    expect([...new Set(split.team2.map((p) => p.level))].sort()).toEqual(["A", "B"]);
  });

  // Test G -- repeat partners.
  it("avoids pairing a player with their immediately-preceding partner when an alternative exists", () => {
    nextId = 1;
    const p1 = player("C");
    const p2 = player("C");
    const p3 = player("C");
    const p4 = player("C");
    const history: PairHistory = {
      ...EMPTY_HISTORY,
      lastPartnerOf: new Map([
        [p1.id, p2.id],
        [p2.id, p1.id],
      ]),
    };
    const split = bestSplit([p1, p2, p3, p4], history, 1000);
    const t1 = new Set(split.team1.map((p) => p.id));
    const t2 = new Set(split.team2.map((p) => p.id));
    const togetherAgain = (t1.has(p1.id) && t1.has(p2.id)) || (t2.has(p1.id) && t2.has(p2.id));
    expect(togetherAgain).toBe(false);
  });
});

describe("matchQuality", () => {
  // Test D -- equal team averages but wide individual skill differences.
  it("does not grade A+E vs A+E as excellent just because team sums match", () => {
    const q = matchQuality(["A", "E"], ["A", "E"]);
    expect(q.grade).not.toBe("excellent");
  });

  it("grades four identical levels as excellent", () => {
    const q = matchQuality(["C", "C"], ["C", "C"]);
    expect(q.grade).toBe("excellent");
  });
});

describe("compareMetrics", () => {
  it("never lets rotation/repeat fairness outrank a real skill-spread difference", () => {
    const spreadOne: MatchMetrics = {
      maxSkillSpread: 1,
      totalSkillDistance: 4,
      teamStrengthDifference: 0,
      withinTeamSkillGap: 2,
      gamesPlayedPenalty: 0,
      waitPriority: 0,
      consecutiveGamePenalty: 0,
      repeatPartnerPenalty: 0,
      repeatOpponentPenalty: 0,
      matchupFrequencyPenalty: 0,
      tieBreak: 0,
    };
    const spreadZeroButWorstEverywhereElse: MatchMetrics = {
      maxSkillSpread: 0,
      totalSkillDistance: 0,
      teamStrengthDifference: 0,
      withinTeamSkillGap: 0,
      gamesPlayedPenalty: 1_000_000,
      waitPriority: 1_000_000,
      consecutiveGamePenalty: 4,
      repeatPartnerPenalty: 100,
      repeatOpponentPenalty: 100,
      matchupFrequencyPenalty: 100,
      tieBreak: 0,
    };
    expect(compareMetrics(spreadZeroButWorstEverywhereElse, spreadOne)).toBeLessThan(0);
  });
});
