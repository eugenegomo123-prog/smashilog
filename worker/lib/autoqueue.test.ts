// Unit tests for the Auto queue planner (worker/lib/autoqueue.ts).
//
// Like matchmaking.test.ts, these call the pure functions directly with fixed
// inputs and a fixed clock, so every case is deterministic -- no database, no
// network, no wall-clock time. vitest/jest-style describe / it / expect are
// assumed, the same as the other test files here.
//
// NOTE: vitest is not a devDependency yet (see the note at the top of
// matchmaking.test.ts for why), so there is no `npm test` today. These cases
// were run with a small stand-in that provides describe / it / expect; once a
// test runner is added from an environment with registry access, this file
// should run as-is.

import { describe, it, expect } from "vitest";
import { bestSplit, compareMetrics, matchQuality, EMPTY_HISTORY, type PlayerForMatchmaking } from "./matchmaking";
import {
  blockedForManualMatch,
  computeRestState,
  isManualQueueFull,
  lookaheadModeFor,
  planAutoQueue,
  planManualInsert,
  playersNeededForLookahead,
  queueTargetLength,
  selectMatchesToStart,
  type AutoMatchInput,
  type AutoPlayerInput,
  type ManualInsertPlan,
} from "./autoqueue";

// ---------------------------------------------------------------------------
// Tiny builders. Times are minutes after a fixed start so the cases read easily.
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 1, 18, 0, 0);
const at = (minute: number) => T0 + Math.round(minute * 60_000);

let nextMatchId = 1;

function player(id: number, level = "C", over: Partial<AutoPlayerInput> = {}): AutoPlayerInput {
  return { id, level, approved: true, status: "active", ...over };
}

function players(count: number, level = "C"): AutoPlayerInput[] {
  return Array.from({ length: count }, (_, i) => player(i + 1, level));
}

// A match that is over.
function finished(ids: number[], startMin: number, endMin: number): AutoMatchInput {
  return {
    id: nextMatchId++,
    status: "completed",
    team1: [ids[0], ids[1]],
    team2: [ids[2], ids[3]],
    startedAt: at(startMin),
    endedAt: at(endMin),
    queuePosition: null,
    auto: false,
  };
}

// A match currently on court.
function onCourt(ids: number[], startMin: number): AutoMatchInput {
  return { ...finished(ids, startMin, startMin), status: "ongoing", endedAt: null };
}

// A match waiting in the queue (auto = planned by the Auto queue, otherwise built by the host).
function waiting(ids: number[], position: number, auto = true): AutoMatchInput {
  return { ...finished(ids, 0, 0), status: "queued", startedAt: at(0), endedAt: null, queuePosition: position, auto };
}

const idsOf = (m: { team1: number[]; team2: number[] }) => [...m.team1, ...m.team2];
const byNumber = (a: number, b: number) => a - b;

// A small seeded random generator, so "random" sessions are the same every run.
function seeded(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------

describe("small helpers", () => {
  it("aims for two rounds ahead, between 2 and the queue cap", () => {
    expect(queueTargetLength(1)).toBe(2);
    expect(queueTargetLength(3)).toBe(6);
    expect(queueTargetLength(4)).toBe(8);
    expect(queueTargetLength(6)).toBe(8);
    expect(queueTargetLength(6, 5)).toBe(5);
  });

  it("only looks ahead when at least 4 players are waiting off court", () => {
    expect(lookaheadModeFor(16, 3)).toBe("full");
    expect(lookaheadModeFor(15, 3)).toBe("small");
    expect(lookaheadModeFor(8, 1)).toBe("full");
    expect(lookaheadModeFor(7, 1)).toBe("small");
  });

  it("says how many players full look-ahead needs: 4 per court plus 4 spare", () => {
    expect(playersNeededForLookahead(1)).toBe(8);
    expect(playersNeededForLookahead(3)).toBe(16);
    expect(playersNeededForLookahead(4)).toBe(20);
    // 0 / odd court counts behave like 1 court, the same as everywhere else
    expect(playersNeededForLookahead(0)).toBe(8);
    for (const courts of [1, 2, 3, 4, 5]) {
      const need = playersNeededForLookahead(courts);
      expect(lookaheadModeFor(need, courts)).toBe("full");
      expect(lookaheadModeFor(need - 1, courts)).toBe("small");
    }
  });
});

describe("computeRestState", () => {
  it("counts games played back to back", () => {
    nextMatchId = 1;
    const ids = [1, 2, 3, 4];
    const state = computeRestState(ids, [finished(ids, 0, 15), finished(ids, 16, 30)]);
    expect(state.get(1)?.streak).toBe(2);
  });

  it("resets the count once a match starts without a free player", () => {
    nextMatchId = 1;
    const state = computeRestState(
      [1, 2, 3, 4, 5, 6, 7, 8],
      [finished([1, 2, 3, 4], 0, 15), finished([5, 6, 7, 8], 16, 31)],
    );
    // 1-4 were free when the second match started and were not in it -> rested.
    expect(state.get(1)?.streak).toBe(0);
    expect(state.get(1)?.idle).toBe(1);
    expect(state.get(5)?.streak).toBe(1);
  });

  it("lets a player on two in a row start again after sitting out one match", () => {
    nextMatchId = 1;
    const state = computeRestState(
      [1, 2, 3, 4, 5, 6, 7, 8],
      [
        finished([1, 2, 3, 4], 0, 15),
        finished([1, 2, 3, 4], 16, 30),
        finished([5, 6, 7, 8], 31, 46), // 1-4 were free and passed over -> rested
      ],
    );
    expect(state.get(1)?.streak).toBe(0);
  });

  it("does not count a match that started while the player was still on court", () => {
    nextMatchId = 1;
    const state = computeRestState(
      [1, 2, 3, 4, 5, 6, 7, 8],
      [onCourt([1, 2, 3, 4], 0), onCourt([5, 6, 7, 8], 10)],
    );
    expect(state.get(1)?.streak).toBe(1);
    expect(state.get(1)?.idle).toBe(0);
  });

  it("counts the match currently on court as a game in the streak", () => {
    nextMatchId = 1;
    const ids = [1, 2, 3, 4];
    const state = computeRestState(ids, [finished(ids, 0, 15), onCourt(ids, 16)]);
    expect(state.get(2)?.streak).toBe(2);
  });
});

describe("planAutoQueue -- filling the queue", () => {
  it("fills an empty session two rounds ahead with 4 distinct players per match", () => {
    nextMatchId = 1;
    const plan = planAutoQueue({ players: players(20), matches: [], courtCount: 3, now: at(0) });
    expect(plan.mode).toBe("full");
    expect(plan.drop).toEqual([]);
    expect(plan.add).toHaveLength(6);
    for (const m of plan.add) expect(new Set(idsOf(m)).size).toBe(4);
    // The first round (one match per free court) uses 12 different players.
    const firstRound = plan.add.slice(0, 3).flatMap(idsOf);
    expect(new Set(firstRound).size).toBe(12);
  });

  it("returns nothing when fewer than 4 players are active", () => {
    nextMatchId = 1;
    const plan = planAutoQueue({ players: players(3), matches: [], courtCount: 1, now: at(0) });
    expect(plan.add).toEqual([]);
  });

  it("ignores resting, inactive and unapproved players", () => {
    nextMatchId = 1;
    const roster = [
      ...players(8),
      player(9, "C", { status: "resting" }),
      player(10, "C", { status: "inactive" }),
      player(11, "C", { approved: false }),
    ];
    const plan = planAutoQueue({ players: roster, matches: [], courtCount: 1, now: at(0) });
    expect(plan.add.length).toBeGreaterThanOrEqual(1);
    for (const m of plan.add) for (const id of idsOf(m)) expect(id <= 8).toBe(true);
  });

  it("does not top up a queue that is already long enough", () => {
    nextMatchId = 1;
    const queue = [0, 1].map((i) => waiting([1 + i * 4, 2 + i * 4, 3 + i * 4, 4 + i * 4], i));
    const plan = planAutoQueue({ players: players(12), matches: queue, courtCount: 1, now: at(0) });
    expect(plan.add).toEqual([]);
  });

  it("never plans more matches than the queue cap allows", () => {
    nextMatchId = 1;
    const plan = planAutoQueue({ players: players(30), matches: [], courtCount: 4, now: at(0), maxQueueLength: 3 });
    expect(plan.add).toHaveLength(3);
  });

  it("gives the same answer for the same input", () => {
    nextMatchId = 1;
    const input = { players: players(18), matches: [onCourt([1, 2, 3, 4], 0)], courtCount: 3, now: at(5) };
    expect(planAutoQueue(input)).toEqual(planAutoQueue(input));
  });

  it("leaves a queue it just planned alone when nothing has changed", () => {
    for (const onCourtNow of [[], [[1, 2, 3, 4]], [[1, 2, 3, 4], [5, 6, 7, 8]]]) {
      nextMatchId = 1;
      const roster = players(20);
      const running = onCourtNow.map((ids, i) => onCourt(ids, i));
      const first = planAutoQueue({ players: roster, matches: running, courtCount: 3, now: at(3) });
      const queued = first.add.map((m, i) => waiting([...m.team1, ...m.team2], i));
      const second = planAutoQueue({ players: roster, matches: [...running, ...queued], courtCount: 3, now: at(3) });
      expect(second.drop).toEqual([]);
      expect(second.add).toEqual([]);
    }
  });
});

describe("planAutoQueue -- choosing the match", () => {
  // The planner narrows the search with a skill-spread shortcut; this proves the
  // shortcut never changes the answer: for random groups it must pick exactly the
  // match you would get by scoring every possible group of four with the
  // matchmaking engine's own comparison.
  it("finds the same match as trying every combination", () => {
    const rand = seeded(7);
    const letters = ["A", "B", "C", "C", "D", "D", "E"];
    let compared = 0;
    for (let trial = 0; trial < 40; trial++) {
      nextMatchId = 1;
      const size = 8 + Math.floor(rand() * 5); // 8-12 players: everyone is on the shortlist
      const roster = Array.from({ length: size }, (_, i) => player(i + 1, letters[Math.floor(rand() * letters.length)]));
      const now = at(0);

      // Everyone has the same games, so the first player is the one the planner starts from.
      const pool: PlayerForMatchmaking[] = roster.map((p) => ({
        id: p.id,
        level: p.level,
        currentStreak: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        gamesPlayed: 0,
        lastMatchEndedAt: null,
        preferredPartnerId: null,
      }));
      const [anchor, ...others] = pool;
      let best: ReturnType<typeof bestSplit> | null = null;
      for (let a = 0; a < others.length - 2; a++) {
        for (let b = a + 1; b < others.length - 1; b++) {
          for (let c = b + 1; c < others.length; c++) {
            const split = bestSplit([anchor, others[a], others[b], others[c]], EMPTY_HISTORY, now);
            if (best === null || compareMetrics(split.metrics, best.metrics) < 0) best = split;
          }
        }
      }
      if (best === null) throw new Error("no combinations");

      // The level guard (tested below) may rightly choose someone else when the best
      // match for the first player is lopsided -- only compare when it is acceptable.
      const grade = matchQuality(
        [best.team1[0].level, best.team1[1].level],
        [best.team2[0].level, best.team2[1].level],
      ).grade;
      if (grade !== "excellent" && grade !== "good" && grade !== "fair") continue;

      const plan = planAutoQueue({ players: roster, matches: [], courtCount: 1, now });
      expect(plan.add[0]).toEqual({
        team1: [best.team1[0].id, best.team1[1].id],
        team2: [best.team2[0].id, best.team2[1].id],
      });
      compared++;
    }
    expect(compared).toBeGreaterThan(20);
  });
});

describe("planAutoQueue -- look-ahead", () => {
  it("plans players who are still on court only for slots they will be free by", () => {
    nextMatchId = 1;
    // 3 courts all busy (matches started 1 minute apart), 6 waiting players.
    const first = [1, 2, 3, 4];
    const second = [5, 6, 7, 8];
    const third = [9, 10, 11, 12];
    const matches = [onCourt(first, 0), onCourt(second, 1), onCourt(third, 2)];
    const plan = planAutoQueue({ players: players(18), matches, courtCount: 3, now: at(3) });
    expect(plan.mode).toBe("full");
    expect(plan.add.length).toBeGreaterThanOrEqual(4);
    // Slot 0 starts when the first match ends: only its players (or waiting players) are free.
    const slot0 = idsOf(plan.add[0]);
    for (const id of [...second, ...third]) expect(slot0.includes(id)).toBe(false);
    // Slot 1 starts when the second ends: the third match's players are still busy.
    const slot1 = idsOf(plan.add[1]);
    for (const id of third) expect(slot1.includes(id)).toBe(false);
  });

  it("uses only players who are free right now when the group is too small to rest anyone", () => {
    nextMatchId = 1;
    // 10 players, 2 courts: 8 on court, 2 waiting -> small mode, nobody can be planned.
    const matches = [onCourt([1, 2, 3, 4], 0), onCourt([5, 6, 7, 8], 1)];
    const plan = planAutoQueue({ players: players(10), matches, courtCount: 2, now: at(3) });
    expect(plan.mode).toBe("small");
    expect(plan.add).toEqual([]);
  });

  it("in a small group, plans the free court from whoever is free", () => {
    nextMatchId = 1;
    // 10 players, 2 courts; one match just finished (1-4 free), the other is on court (5-8).
    const matches = [finished([1, 2, 3, 4], 0, 15), onCourt([5, 6, 7, 8], 1)];
    const plan = planAutoQueue({ players: players(10), matches, courtCount: 2, now: at(16) });
    expect(plan.mode).toBe("small");
    expect(plan.add).toHaveLength(1);
    for (const id of idsOf(plan.add[0])) expect([5, 6, 7, 8].includes(id)).toBe(false);
  });
});

describe("planAutoQueue -- fair games", () => {
  it("picks the players with the fewest games first", () => {
    nextMatchId = 1;
    // 16 same-level players; 1-12 have played 3 games each, 13-16 none.
    const history: AutoMatchInput[] = [];
    for (let round = 0; round < 3; round++) {
      for (let g = 0; g < 3; g++) {
        const base = g * 4;
        history.push(finished([base + 1, base + 2, base + 3, base + 4], round * 40 + g, round * 40 + g + 15));
      }
    }
    const plan = planAutoQueue({ players: players(16), matches: history, courtCount: 1, now: at(200) });
    expect(plan.add.length).toBeGreaterThanOrEqual(1);
    expect(idsOf(plan.add[0]).sort(byNumber)).toEqual([13, 14, 15, 16]);
  });

  it("counts games already waiting in the queue", () => {
    nextMatchId = 1;
    const queue = [waiting([1, 2, 3, 4], 0, false)];
    const plan = planAutoQueue({ players: players(8), matches: queue, courtCount: 1, now: at(0) });
    expect(plan.add).toHaveLength(1);
    expect(idsOf(plan.add[0]).sort(byNumber)).toEqual([5, 6, 7, 8]);
  });

  it("counts a late arrival's credited games, so they do not jump the line", () => {
    nextMatchId = 1;
    // Players 1-8 have each played 2 games. 9-11 have not played at all.
    const history = [
      finished([1, 2, 3, 4], 0, 15),
      finished([5, 6, 7, 8], 16, 31),
      finished([1, 2, 3, 4], 32, 47),
      finished([5, 6, 7, 8], 48, 63),
    ];
    // (a) Player 12 has not played either: four players with no games, so they go first together.
    const noCredit = planAutoQueue({ players: players(12), matches: history, courtCount: 1, now: at(70) });
    expect(idsOf(noCredit.add[0]).sort(byNumber)).toEqual([9, 10, 11, 12]);
    // (b) Player 12 arrived late and was credited 2 games; player 13 is a fourth player with no games.
    const credited = [...players(11), player(12, "C", { gamesBaseline: 2 }), player(13)];
    const withCredit = planAutoQueue({ players: credited, matches: history, courtCount: 1, now: at(70) });
    expect(idsOf(withCredit.add[0]).sort(byNumber)).toEqual([9, 10, 11, 13]);
  });
});

describe("planAutoQueue -- rest rule", () => {
  it("never plans a third game in a row while other players are available", () => {
    nextMatchId = 1;
    const roster = players(12);
    const history: AutoMatchInput[] = [];
    // 5-12 have played lots of games a long time ago; 1-4 are on their second game in a row.
    for (let r = 0; r < 5; r++) {
      history.push(finished([5, 6, 7, 8], r * 30, r * 30 + 15));
      history.push(finished([9, 10, 11, 12], r * 30 + 1, r * 30 + 16));
    }
    history.push(finished([1, 2, 3, 4], 200, 215));
    history.push(finished([1, 2, 3, 4], 216, 230));
    // 1-4 have played the fewest games, so fairness alone would put them straight back on.
    const plan = planAutoQueue({ players: roster, matches: history, courtCount: 1, now: at(231) });
    expect(plan.add.length).toBeGreaterThanOrEqual(1);
    for (const id of idsOf(plan.add[0])) expect([1, 2, 3, 4].includes(id)).toBe(false);
  });

  it("bends the rule for a court that is free right now when there is no one else", () => {
    nextMatchId = 1;
    // Only 5 players; 1-4 are on their second game in a row. A court is free -- it must still be filled.
    const history = [finished([1, 2, 3, 4], 0, 15), finished([1, 2, 3, 4], 16, 30)];
    const plan = planAutoQueue({ players: players(5), matches: history, courtCount: 1, now: at(31) });
    expect(plan.mode).toBe("small");
    expect(plan.add).toHaveLength(1);
    // The one rested player (5) is certainly in it.
    expect(idsOf(plan.add[0]).includes(5)).toBe(true);
  });
});

describe("planAutoQueue -- level guard", () => {
  const others = Array.from({ length: 11 }, (_, i) => player(i + 2, "C"));

  it("skips a player whose best available match would be badly uneven", () => {
    nextMatchId = 1;
    const history = [finished([2, 3, 4, 5], 0, 15)];
    // Sanity check: if player 1 were level C like everyone else, they have played
    // least and would be the first one picked...
    const sameLevel = planAutoQueue({ players: [player(1, "C"), ...others], matches: history, courtCount: 1, now: at(400) });
    expect(idsOf(sameLevel.add[0]).includes(1)).toBe(true);
    // ...but as the only A among C players the best match they could get is
    // lopsided, so the next player in line is used instead.
    const guarded = planAutoQueue({ players: [player(1, "A"), ...others], matches: history, courtCount: 1, now: at(400) });
    expect(guarded.add.length).toBeGreaterThanOrEqual(1);
    expect(idsOf(guarded.add[0]).includes(1)).toBe(false);
  });

  it("stops skipping them once they have been passed over for two rounds", () => {
    nextMatchId = 1;
    // Three finished matches among the C players only: the A has been passed over 3 times.
    const history = [
      finished([2, 3, 4, 5], 0, 15),
      finished([6, 7, 8, 9], 16, 31),
      finished([2, 6, 10, 11], 32, 47),
    ];
    const plan = planAutoQueue({ players: [player(1, "A"), ...others], matches: history, courtCount: 1, now: at(400) });
    expect(plan.add.length).toBeGreaterThanOrEqual(1);
    expect(idsOf(plan.add[0]).includes(1)).toBe(true);
  });
});

describe("planAutoQueue -- repairing the queue", () => {
  it("drops an auto match that now includes a resting player, and keeps the rest", () => {
    nextMatchId = 1;
    const roster = players(16).map((p) => (p.id === 5 ? { ...p, status: "resting" } : p));
    const m1 = waiting([1, 2, 3, 4], 0);
    const m2 = waiting([5, 6, 7, 8], 1);
    const m3 = waiting([9, 10, 11, 12], 2);
    const plan = planAutoQueue({ players: roster, matches: [m1, m2, m3], courtCount: 1, now: at(0) });
    expect(plan.drop).toEqual([m2.id]);
  });

  it("never drops a match the host built by hand", () => {
    nextMatchId = 1;
    const roster = players(16).map((p) => (p.id === 5 ? { ...p, status: "resting" } : p));
    const manual = waiting([5, 6, 7, 8], 0, false);
    const plan = planAutoQueue({ players: roster, matches: [manual], courtCount: 1, now: at(0) });
    expect(plan.drop).toEqual([]);
  });

  it("drops an auto match that would be a third game in a row when others are free", () => {
    nextMatchId = 1;
    const history = [finished([1, 2, 3, 4], 0, 15), finished([1, 2, 3, 4], 16, 30)];
    const stale = waiting([1, 2, 3, 4], 0);
    const plan = planAutoQueue({ players: players(16), matches: [...history, stale], courtCount: 1, now: at(31) });
    expect(plan.drop).toEqual([stale.id]);
    // ...and the replacement does not use them.
    expect(plan.add.length).toBeGreaterThanOrEqual(1);
    for (const id of idsOf(plan.add[0])) expect([1, 2, 3, 4].includes(id)).toBe(false);
  });

  it("keeps a manual match even if it would be a third game in a row", () => {
    nextMatchId = 1;
    const history = [finished([1, 2, 3, 4], 0, 15), finished([1, 2, 3, 4], 16, 30)];
    const manual = waiting([1, 2, 3, 4], 0, false);
    const plan = planAutoQueue({ players: players(16), matches: [...history, manual], courtCount: 1, now: at(31) });
    expect(plan.drop).toEqual([]);
  });
});

describe("selectMatchesToStart", () => {
  it("starts the first ready match and skips one whose player is still on court", () => {
    nextMatchId = 1;
    const matches = [onCourt([1, 2, 3, 4], 0), waiting([1, 5, 6, 7], 0), waiting([8, 9, 10, 11], 1)];
    const sel = selectMatchesToStart({ players: players(12), matches, openCourts: 1, enforceRest: false });
    expect(sel.start).toEqual([matches[2].id]);
  });

  it("skips a match with a resting player (stays in the queue, as today)", () => {
    nextMatchId = 1;
    const roster = players(12).map((p) => (p.id === 2 ? { ...p, status: "resting" } : p));
    const matches = [waiting([1, 2, 3, 4], 0), waiting([5, 6, 7, 8], 1)];
    const sel = selectMatchesToStart({ players: roster, matches, openCourts: 1, enforceRest: false });
    expect(sel.start).toEqual([matches[1].id]);
  });

  it("never puts the same player on two courts at once", () => {
    nextMatchId = 1;
    const matches = [waiting([1, 2, 3, 4], 0), waiting([1, 5, 6, 7], 1), waiting([8, 9, 10, 11], 2)];
    const sel = selectMatchesToStart({ players: players(12), matches, openCourts: 3, enforceRest: false });
    expect(sel.start).toEqual([matches[0].id, matches[2].id]);
  });

  it("only fills as many courts as are open", () => {
    nextMatchId = 1;
    const matches = [waiting([1, 2, 3, 4], 0), waiting([5, 6, 7, 8], 1)];
    expect(selectMatchesToStart({ players: players(12), matches, openCourts: 1, enforceRest: false }).start).toHaveLength(1);
    expect(selectMatchesToStart({ players: players(12), matches, openCourts: 0, enforceRest: false }).start).toHaveLength(0);
  });

  it("with the rest rule on, holds back an auto match with a tired player when rested players are free", () => {
    nextMatchId = 1;
    const history = [finished([1, 2, 3, 4], 0, 15), finished([1, 2, 3, 4], 16, 30)];
    const tired = waiting([1, 2, 3, 4], 0);
    const fresh = waiting([5, 6, 7, 8], 1);
    const sel = selectMatchesToStart({ players: players(12), matches: [...history, tired, fresh], openCourts: 1, enforceRest: true });
    expect(sel.start).toEqual([fresh.id]);
  });

  it("with the rest rule on, still starts the tired match if not enough rested players are free", () => {
    nextMatchId = 1;
    const history = [finished([1, 2, 3, 4], 0, 15), finished([1, 2, 3, 4], 16, 30)];
    const tired = waiting([1, 2, 3, 4], 0);
    const sel = selectMatchesToStart({ players: players(5), matches: [...history, tired], openCourts: 1, enforceRest: true });
    expect(sel.start).toEqual([tired.id]);
  });

  it("never holds back a match the host built by hand", () => {
    nextMatchId = 1;
    const history = [finished([1, 2, 3, 4], 0, 15), finished([1, 2, 3, 4], 16, 30)];
    const manual = waiting([1, 2, 3, 4], 0, false);
    const sel = selectMatchesToStart({ players: players(12), matches: [...history, manual], openCourts: 1, enforceRest: true });
    expect(sel.start).toEqual([manual.id]);
  });
});

// ---------------------------------------------------------------------------
// A whole (short) mock session, driven the way the server will drive the
// planner: fill courts -> plan the queue -> fill courts again, every time a
// match finishes. The result is checked by a separate counter (measure) that
// does not use the planner's own bookkeeping.
// ---------------------------------------------------------------------------

// Longest run of games in a row (a run is broken when a match starts while the
// player is free and not in it), the gap between the most- and least-played
// player, and how many matches finished.
function measure(roster: AutoPlayerInput[], all: AutoMatchInput[]) {
  const played = all.filter((m) => m.status === "completed" || m.status === "ongoing");
  const done = all.filter((m) => m.status === "completed");
  const counts: number[] = [];
  let longestRun = 0;
  for (const p of roster) {
    const mine = done
      .filter((m) => idsOf(m).includes(p.id))
      .sort((a, b) => (a.startedAt as number) - (b.startedAt as number));
    counts.push(mine.length);
    let run = mine.length ? 1 : 0;
    longestRun = Math.max(longestRun, run);
    for (let k = 1; k < mine.length; k++) {
      const previousEnd = mine[k - 1].endedAt as number;
      const nextStart = mine[k].startedAt as number;
      const rested = played.some(
        (m) => (m.startedAt as number) > previousEnd && (m.startedAt as number) < nextStart && !idsOf(m).includes(p.id),
      );
      run = rested ? 1 : run + 1;
      longestRun = Math.max(longestRun, run);
    }
  }
  return { longestRun, gap: Math.max(...counts) - Math.min(...counts), finished: done.length };
}

function mockSession(playerCount: number, courts: number, seed: number, minutes: number) {
  const rand = seeded(seed);
  const levels = ["A", "B", "B", "C", "C", "C", "C", "D", "D", "E"];
  const roster = Array.from({ length: playerCount }, (_, i) => player(i + 1, levels[Math.floor(rand() * levels.length)]));
  let clock = T0;
  const tick = () => (clock += 1);
  let minute = 0;
  let all: AutoMatchInput[] = [];
  let nextId = 1;
  const endsAt = new Map<number, number>();
  const running = () => all.filter((m) => m.status === "ongoing");

  const fill = () => {
    const open = courts - running().length;
    if (open <= 0) return;
    const { start } = selectMatchesToStart({ players: roster, matches: all, openCourts: open, enforceRest: true });
    for (const id of start) {
      const m = all.find((x) => x.id === id) as AutoMatchInput;
      m.status = "ongoing";
      m.startedAt = tick();
      m.queuePosition = null;
      endsAt.set(id, minute + 12 + rand() * 10);
    }
  };
  const plan = () => {
    const result = planAutoQueue({ players: roster, matches: all, courtCount: courts, now: tick() });
    all = all.filter((m) => !result.drop.includes(m.id));
    let position = Math.max(-1, ...all.filter((m) => m.status === "queued").map((m) => m.queuePosition ?? 0)) + 1;
    for (const a of result.add) {
      all.push({ id: nextId++, status: "queued", team1: a.team1, team2: a.team2, startedAt: tick(), endedAt: null, queuePosition: position++, auto: true });
    }
  };
  const step = () => {
    fill();
    plan();
    fill();
  };

  step();
  let longestQueue = 0;
  while (running().length > 0) {
    const next = Math.min(...running().map((m) => endsAt.get(m.id) as number));
    if (next > minutes) break;
    minute = next;
    clock = Math.max(clock, T0 + Math.round(minute * 60_000));
    for (const m of running()) {
      if ((endsAt.get(m.id) as number) <= minute + 1e-9) {
        m.status = "completed";
        m.endedAt = tick();
      }
    }
    step();
    longestQueue = Math.max(longestQueue, all.filter((m) => m.status === "queued").length);
  }

  return { ...measure(roster, all), longestQueue };
}

// ---------------------------------------------------------------------------
// Matches the host builds by hand while Auto queue is on
// ---------------------------------------------------------------------------

// What the database does with a plan: remove the dropped matches, move the shifted
// ones, then add the new match. Returns the queue in order, as [id, position].
function applyManualPlan(queue: AutoMatchInput[], plan: ManualInsertPlan, newId: number): { id: number; position: number }[] {
  const dropped = new Set(plan.dropIds);
  const moved = new Map(plan.shift.map((s) => [s.id, s.position]));
  const rows = queue
    .filter((m) => !dropped.has(m.id))
    .map((m) => ({ id: m.id, position: moved.get(m.id) ?? m.queuePosition ?? 0 }));
  rows.push({ id: newId, position: plan.position });
  return rows.sort((a, b) => a.position - b.position || a.id - b.id);
}

describe("isManualQueueFull / blockedForManualMatch", () => {
  it("counts every queued match when Auto queue is off", () => {
    nextMatchId = 1;
    const seven = Array.from({ length: 7 }, (_, i) => waiting([1, 2, 3, 4], i, true));
    expect(isManualQueueFull(seven, false)).toBe(false);
    expect(isManualQueueFull([...seven, waiting([5, 6, 7, 8], 7, true)], false)).toBe(true);
  });

  it("does not count planned matches when Auto queue is on -- they can make room", () => {
    nextMatchId = 1;
    const planned = Array.from({ length: 8 }, (_, i) => waiting([1, 2, 3, 4], i, true));
    expect(isManualQueueFull(planned, true)).toBe(false);
    const mixed = [...Array.from({ length: 7 }, (_, i) => waiting([1, 2, 3, 4], i, false)), waiting([5, 6, 7, 8], 7, true)];
    expect(isManualQueueFull(mixed, true)).toBe(false);
    const handMade = Array.from({ length: 8 }, (_, i) => waiting([1, 2, 3, 4], i, false));
    expect(isManualQueueFull(handMade, true)).toBe(true);
    expect(isManualQueueFull(handMade, false, 9)).toBe(false);
  });

  it("matches on court, finished matches and the cap argument", () => {
    nextMatchId = 1;
    const m = [onCourt([1, 2, 3, 4], 0), finished([5, 6, 7, 8], 0, 10)];
    expect(isManualQueueFull(m, true)).toBe(false);
    expect(isManualQueueFull([waiting([1, 2, 3, 4], 0, false), waiting([5, 6, 7, 8], 1, false)], true, 2)).toBe(true);
  });

  it("blocks players on court always, and players in queued matches unless they are planned ones with Auto on", () => {
    nextMatchId = 1;
    const m = [
      onCourt([1, 2, 3, 4], 0),
      waiting([5, 6, 7, 8], 0, false), // host-built
      waiting([9, 10, 11, 12], 1, true), // planned
      finished([13, 14, 15, 16], 0, 10),
    ];
    const off = blockedForManualMatch(m, false);
    expect([...off].sort(byNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const on = blockedForManualMatch(m, true);
    expect([...on].sort(byNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("with Auto off gives exactly the players a database 'on court or queued' check would", () => {
    nextMatchId = 1;
    const m = [onCourt([1, 2, 3, 4], 0), waiting([5, 6, 7, 8], 0, true), finished([9, 10, 11, 12], 0, 10)];
    expect([...blockedForManualMatch(m, false)].sort(byNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("planManualInsert", () => {
  it("with Auto off: goes last, nothing removed or moved, planned flags ignored", () => {
    nextMatchId = 1;
    const q = [waiting([1, 2, 3, 4], 0, true), waiting([5, 6, 7, 8], 1, false), waiting([9, 10, 11, 12], 4, true)];
    const plan = planManualInsert(q, [13, 14, 15, 16], false);
    expect(plan).toEqual({ dropIds: [], position: 5, shift: [] });
    expect(planManualInsert([], [1, 2, 3, 4], false)).toEqual({ dropIds: [], position: 0, shift: [] });
  });

  it("with Auto off, a clash is not its job to resolve -- nothing is dropped even if a planned match shares a player", () => {
    nextMatchId = 1;
    const q = [waiting([1, 2, 3, 4], 0, true)];
    expect(planManualInsert(q, [1, 5, 6, 7], false).dropIds).toEqual([]);
  });

  it("with Auto on and an empty queue: position 0", () => {
    expect(planManualInsert([], [1, 2, 3, 4], true)).toEqual({ dropIds: [], position: 0, shift: [] });
  });

  it("goes in front of the planned matches, which each move back one place", () => {
    nextMatchId = 1;
    const a = waiting([1, 2, 3, 4], 0, true);
    const b = waiting([5, 6, 7, 8], 1, true);
    const c = waiting([9, 10, 11, 12], 2, true);
    const plan = planManualInsert([a, b, c], [13, 14, 15, 16], true);
    expect(plan.dropIds).toEqual([]);
    expect(plan.position).toBe(0);
    expect(plan.shift).toEqual([
      { id: a.id, position: 1 },
      { id: b.id, position: 2 },
      { id: c.id, position: 3 },
    ]);
  });

  it("goes behind matches the host made earlier, in front of the planned ones", () => {
    nextMatchId = 1;
    const m1 = waiting([1, 2, 3, 4], 0, false);
    const m2 = waiting([5, 6, 7, 8], 1, false);
    const a = waiting([9, 10, 11, 12], 2, true);
    const b = waiting([13, 14, 15, 16], 3, true);
    const plan = planManualInsert([a, m2, b, m1], [17, 18, 19, 20], true); // input order does not matter
    expect(plan.position).toBe(2);
    expect(plan.shift).toEqual([
      { id: a.id, position: 3 },
      { id: b.id, position: 4 },
    ]);
  });

  it("goes to the end when there are no planned matches behind it", () => {
    nextMatchId = 1;
    const q = [waiting([1, 2, 3, 4], 0, false), waiting([5, 6, 7, 8], 1, false)];
    expect(planManualInsert(q, [9, 10, 11, 12], true)).toEqual({ dropIds: [], position: 2, shift: [] });
  });

  it("keeps a planned match that sits ahead of an older hand-made one where it is", () => {
    nextMatchId = 1;
    const a1 = waiting([1, 2, 3, 4], 0, true);
    const m1 = waiting([5, 6, 7, 8], 1, false);
    const a2 = waiting([9, 10, 11, 12], 2, true);
    const plan = planManualInsert([a1, m1, a2], [13, 14, 15, 16], true);
    expect(plan.position).toBe(2);
    expect(plan.shift).toEqual([{ id: a2.id, position: 3 }]);
  });

  it("removes the planned matches that share a player, and only those", () => {
    nextMatchId = 1;
    const a = waiting([1, 2, 3, 4], 0, true);
    const b = waiting([5, 6, 7, 8], 1, true);
    const c = waiting([9, 10, 11, 12], 2, true);
    const plan = planManualInsert([a, b, c], [2, 6, 13, 14], true);
    expect(plan.dropIds.sort(byNumber)).toEqual([a.id, b.id].sort(byNumber));
    const after = applyManualPlan([a, b, c], plan, 999);
    expect(after.map((r) => r.id)).toEqual([999, c.id]);
  });

  it("never removes a match the host made, even if it shares a player", () => {
    nextMatchId = 1;
    const m = waiting([1, 2, 3, 4], 0, false);
    const a = waiting([5, 6, 7, 8], 1, true);
    // (the route refuses this before it gets here -- the planner is just never allowed to delete a host match)
    expect(planManualInsert([m, a], [1, 9, 10, 11], true).dropIds).toEqual([]);
  });

  it("when the queue is full, the planned match at the very back makes the room", () => {
    nextMatchId = 1;
    const q = Array.from({ length: 8 }, (_, i) => waiting([4 * i + 1, 4 * i + 2, 4 * i + 3, 4 * i + 4], i, true));
    const plan = planManualInsert(q, [101, 102, 103, 104], true);
    expect(plan.dropIds).toEqual([q[7].id]);
    expect(applyManualPlan(q, plan, 999).map((r) => r.id)).toEqual([999, ...q.slice(0, 7).map((m) => m.id)]);
  });

  it("when full of a mix, room is made from the planned ones only, back first", () => {
    nextMatchId = 1;
    const q = [
      waiting([1, 2, 3, 4], 0, false),
      waiting([5, 6, 7, 8], 1, true),
      waiting([9, 10, 11, 12], 2, false),
      waiting([13, 14, 15, 16], 3, true),
      waiting([17, 18, 19, 20], 4, true),
      waiting([21, 22, 23, 24], 5, false),
      waiting([25, 26, 27, 28], 6, true),
      waiting([29, 30, 31, 32], 7, true),
    ];
    const plan = planManualInsert(q, [101, 102, 103, 104], true);
    expect(plan.dropIds).toEqual([q[7].id]);
    const after = applyManualPlan(q, plan, 999).map((r) => r.id);
    expect(after.length).toBe(8);
    // right behind the host's last match (the one at place 6 in the old list), ahead of the planned one that follows
    expect(after).toEqual([q[0].id, q[1].id, q[2].id, q[3].id, q[4].id, q[5].id, 999, q[6].id]);
  });

  it("a clash that already frees a place means nothing else is removed", () => {
    nextMatchId = 1;
    const q = Array.from({ length: 8 }, (_, i) => waiting([4 * i + 1, 4 * i + 2, 4 * i + 3, 4 * i + 4], i, true));
    const plan = planManualInsert(q, [1, 101, 102, 103], true);
    expect(plan.dropIds).toEqual([q[0].id]);
  });

  it("uses a free queue number instead of moving matches when there is a gap", () => {
    nextMatchId = 1;
    const m = waiting([1, 2, 3, 4], 0, false);
    const a = waiting([5, 6, 7, 8], 5, true);
    const plan = planManualInsert([m, a], [9, 10, 11, 12], true);
    expect(plan).toEqual({ dropIds: [], position: 1, shift: [] });
  });

  it("only moves as many matches as it must when numbers are uneven", () => {
    nextMatchId = 1;
    const a = waiting([1, 2, 3, 4], 0, true);
    const b = waiting([5, 6, 7, 8], 1, true);
    const c = waiting([9, 10, 11, 12], 4, true);
    const plan = planManualInsert([a, b, c], [13, 14, 15, 16], true);
    expect(plan.position).toBe(0);
    expect(plan.shift).toEqual([
      { id: a.id, position: 1 },
      { id: b.id, position: 2 },
    ]); // c already has room
  });

  it("handles matches stored without a queue number as position 0", () => {
    nextMatchId = 1;
    const a = { ...waiting([1, 2, 3, 4], 0, true), queuePosition: null };
    const plan = planManualInsert([a], [5, 6, 7, 8], true);
    expect(applyManualPlan([a], plan, 999).map((r) => r.id)).toEqual([999, a.id]);
  });

  it("random queues: the order is [kept before] + new + [kept after], numbers are unique, nothing but planned matches is removed", () => {
    const rand = seeded(77);
    let checked = 0;
    let withDrops = 0;
    let withShifts = 0;
    let madeRoom = 0;
    for (let n = 0; n < 6000; n++) {
      nextMatchId = 1;
      const autoOn = rand() < 0.7;
      const len = rand() < 0.25 ? 8 : Math.floor(rand() * 8); // 0..8, often a full queue
      let position = rand() < 0.8 ? 0 : 1 + Math.floor(rand() * 2);
      const queue: AutoMatchInput[] = [];
      for (let i = 0; i < len; i++) {
        const ids = [0, 1, 2, 3].map(() => 1 + Math.floor(rand() * 20));
        if (new Set(ids).size < 4) continue;
        queue.push(waiting(ids, position, rand() < 0.6));
        position += 1 + (rand() < 0.2 ? Math.floor(rand() * 3) : 0); // sometimes a gap
      }
      if (isManualQueueFull(queue, autoOn)) continue;
      // four players the route would let through (not on court, not in a match of the host's)
      const blocked = blockedForManualMatch(queue, autoOn);
      const open = Array.from({ length: 20 }, (_, i) => i + 1).filter((id) => !blocked.has(id));
      if (open.length < 4) continue;
      const involved: number[] = [];
      while (involved.length < 4) involved.push(open.splice(Math.floor(rand() * open.length), 1)[0]);

      const plan = planManualInsert(queue, involved, autoOn);
      const after = applyManualPlan(queue, plan, 999);
      checked++;
      if (plan.dropIds.length > 0) withDrops++;
      if (plan.shift.length > 0) withShifts++;
      if (autoOn && queue.length === 8 && plan.dropIds.length > 0) madeRoom++;

      expect(after.length).toBeLessThanOrEqual(8);
      expect(new Set(after.map((r) => r.position)).size).toBe(after.length);
      for (const id of plan.dropIds) expect(queue.find((m) => m.id === id)?.auto).toBe(true);
      if (!autoOn) {
        expect(plan.dropIds).toEqual([]);
        expect(after[after.length - 1].id).toBe(999);
      } else {
        // every planned match sharing a player is gone; every host-made match is still there
        const clashing = queue.filter((m) => m.auto && idsOf(m).some((id) => involved.includes(id))).map((m) => m.id);
        for (const id of clashing) expect(plan.dropIds.includes(id)).toBe(true);
        for (const m of queue.filter((x) => !x.auto)) expect(after.some((r) => r.id === m.id)).toBe(true);
        // the new match sits behind every host-made match and ahead of every planned one that is left
        const at999 = after.findIndex((r) => r.id === 999);
        const manualIds = new Set(queue.filter((m) => !m.auto).map((m) => m.id));
        const lastManual = after.reduce((acc, r, i) => (manualIds.has(r.id) ? i : acc), -1);
        expect(at999).toBeGreaterThan(lastManual);
      }
      // everyone who was already queued keeps their relative order
      const before = queue.filter((m) => !plan.dropIds.includes(m.id)).sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0) || a.id - b.id).map((m) => m.id);
      expect(after.filter((r) => r.id !== 999).map((r) => r.id)).toEqual(before);
    }
    // enough of the interesting cases were really exercised
    expect(checked).toBeGreaterThan(3000);
    expect(withDrops).toBeGreaterThan(1000);
    expect(withShifts).toBeGreaterThan(500);
    expect(madeRoom).toBeGreaterThan(30);
  });
});

describe("the mock-session checker", () => {
  it("notices a third game in a row, and a rest in between", () => {
    nextMatchId = 1;
    const roster = players(8);
    const group = [1, 2, 3, 4];
    const threeInARow = [finished(group, 0, 15), finished(group, 16, 30), finished(group, 31, 45)];
    expect(measure(roster, threeInARow).longestRun).toBe(3);
    const withRest = [
      finished(group, 0, 15),
      finished(group, 16, 30),
      finished([5, 6, 7, 8], 31, 45),
      finished(group, 46, 60),
    ];
    expect(measure(roster, withRest).longestRun).toBe(2);
  });
});

describe("a mock session, start to finish", () => {
  it("keeps games fair and never gives anyone a third game in a row (20 players, 3 courts)", () => {
    for (const seed of [1, 2, 3]) {
      const result = mockSession(20, 3, seed, 150);
      expect(result.finished).toBeGreaterThan(20);
      expect(result.longestRun).toBeLessThanOrEqual(2);
      expect(result.gap).toBeLessThanOrEqual(5);
      expect(result.longestQueue).toBeLessThanOrEqual(8);
    }
  });

  it("does the same with 24 players on 4 courts", () => {
    for (const seed of [4, 5]) {
      const result = mockSession(24, 4, seed, 150);
      expect(result.longestRun).toBeLessThanOrEqual(2);
      expect(result.gap).toBeLessThanOrEqual(5);
      expect(result.longestQueue).toBeLessThanOrEqual(8);
    }
  });
});
