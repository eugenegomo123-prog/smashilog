// Unit tests for the rating engine (worker/lib/rating.ts).
//
// These exercise the pure functions directly with fixed inputs, so every
// scenario is deterministic and reproducible -- no database, no network, no
// wall-clock time. Run with your existing test runner (vitest/jest-style
// `describe`/`it`/`expect` APIs assumed; adjust the two imports at the top if
// this project uses a different one).

import { describe, it, expect } from "vitest";
import {
  rateMatch,
  teamEffectiveRating,
  expectedScore,
  kFactorFor,
  decayRatingDeviation,
  growRatingDeviationForInactivity,
  marginMultiplier,
  repeatPenaltyMultiplier,
  seasonPointsForWin,
  mmrToTier,
  flagSuspiciousActivity,
  BASE_MMR,
  RD_START,
  RD_FLOOR,
  K_MAX,
  type RatedPlayer,
} from "./rating";

// A calibrated player: enough rated games that RD has settled to the floor,
// so K is at its normal minimum (24) and results are easy to reason about.
function calibrated(mmr: number, overrides: Partial<RatedPlayer> = {}): RatedPlayer {
  return {
    accountId: 1,
    effectiveMmr: mmr,
    ratingDeviation: RD_FLOOR,
    ratedGamesPlayed: 50,
    seasonPoints: 0,
    currentStreak: 0,
    playingMode: "competitive",
    ...overrides,
  };
}

function freshPlayer(mmr: number, overrides: Partial<RatedPlayer> = {}): RatedPlayer {
  return {
    accountId: 1,
    effectiveMmr: mmr,
    ratingDeviation: RD_START,
    ratedGamesPlayed: 0,
    seasonPoints: 0,
    currentStreak: 0,
    playingMode: "competitive",
    ...overrides,
  };
}

describe("teamEffectiveRating", () => {
  it("equals the plain average when both players are equal", () => {
    expect(teamEffectiveRating(1000, 1000)).toBe(1000);
  });

  it("applies a penalty proportional to the internal skill gap", () => {
    // avg = 1100, gap = 200 -> penalty = min(50, 0.1*200) = 20
    expect(teamEffectiveRating(1200, 1000)).toBe(1080);
  });

  it("caps the gap penalty at 50 regardless of how large the gap is", () => {
    // avg = 1500, gap = 2000 -> penalty would be 200 uncapped, but caps at 50
    expect(teamEffectiveRating(2500, 500)).toBe(1450);
  });
});

describe("expectedScore", () => {
  it("is exactly 0.5 for equal ratings", () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 6);
  });

  it("favors the higher-rated player", () => {
    expect(expectedScore(1200, 1000)).toBeGreaterThan(0.5);
    expect(expectedScore(1000, 1200)).toBeLessThan(0.5);
  });

  it("is symmetric: favorite's expectation + underdog's expectation = 1", () => {
    const favorite = expectedScore(1400, 1000);
    const underdog = expectedScore(1000, 1400);
    expect(favorite + underdog).toBeCloseTo(1, 6);
  });
});

describe("kFactorFor", () => {
  it("returns the normal baseline (24) once RD has settled at the floor", () => {
    expect(kFactorFor(RD_FLOOR)).toBe(24);
  });

  it("caps at K_MAX for a brand-new player's starting RD", () => {
    // 24 * (350/50) = 168, clamped down to K_MAX (120)
    expect(kFactorFor(RD_START)).toBe(K_MAX);
  });

  it("scales smoothly between the floor and the cap", () => {
    const low = kFactorFor(100);
    const high = kFactorFor(200);
    expect(high).toBeGreaterThan(low);
    expect(low).toBeGreaterThanOrEqual(24);
    expect(high).toBeLessThanOrEqual(120);
  });
});

describe("decayRatingDeviation / growRatingDeviationForInactivity", () => {
  it("shrinks RD after a rated match but never below the floor", () => {
    expect(decayRatingDeviation(100)).toBeCloseTo(92, 6);
    expect(decayRatingDeviation(RD_FLOOR)).toBe(RD_FLOOR); // already basically at floor, decay keeps it there
  });

  it("grows RD back after a long layoff, capped at RD_MAX", () => {
    const grown = growRatingDeviationForInactivity(RD_FLOOR, 30); // one 30-day period
    expect(grown).toBeGreaterThan(RD_FLOOR);
    expect(grown).toBeLessThanOrEqual(350);
  });

  it("never exceeds RD_MAX even after an extremely long layoff", () => {
    const grown = growRatingDeviationForInactivity(RD_FLOOR, 365 * 5);
    expect(grown).toBe(350);
  });
});

describe("marginMultiplier", () => {
  it("is close to 1.0 for a typical close game (21-19) between near-equal teams", () => {
    const mult = marginMultiplier(21, 19, 0);
    expect(mult).toBeGreaterThan(0.9);
    expect(mult).toBeLessThan(1.3);
  });

  it("increases with a larger margin between equal teams, but stays capped", () => {
    const close = marginMultiplier(21, 19, 0);
    const blowout = marginMultiplier(21, 0, 0);
    expect(blowout).toBeGreaterThan(close);
    expect(blowout).toBeLessThanOrEqual(1.8);
  });

  it("dampens the margin bonus when the winner was already heavily favored", () => {
    const expectedWin = marginMultiplier(21, 5, 400); // winner was 400 Elo points higher
    const upset = marginMultiplier(21, 5, -400); // same margin, but winner was the underdog
    expect(upset).toBeGreaterThan(expectedWin);
  });

  it("never goes below the floor even for a 1-point win", () => {
    expect(marginMultiplier(21, 20, 0)).toBeGreaterThanOrEqual(0.6);
  });
});

describe("repeatPenaltyMultiplier", () => {
  it("is 1.0 (no penalty) for a first or only meeting", () => {
    expect(repeatPenaltyMultiplier(0)).toBe(1);
    expect(repeatPenaltyMultiplier(1)).toBe(1);
  });

  it("reduces the multiplier for repeated recent meetings, down to a floor", () => {
    expect(repeatPenaltyMultiplier(3)).toBeCloseTo(0.7, 6);
    expect(repeatPenaltyMultiplier(20)).toBe(0.4); // floored, never zero
  });
});

describe("seasonPointsForWin", () => {
  it("awards more for beating a stronger opponent", () => {
    const vsWeak = seasonPointsForWin(800, 0);
    const vsStrong = seasonPointsForWin(1300, 0);
    expect(vsStrong).toBeGreaterThan(vsWeak);
  });

  it("adds a capped streak bonus", () => {
    const noStreak = seasonPointsForWin(1000, 1); // 1 = first win, no streak bonus yet
    const longStreak = seasonPointsForWin(1000, 10); // streak bonus caps at 5*2=10
    expect(longStreak - noStreak).toBe(10);
  });
});

describe("mmrToTier", () => {
  it("places a brand-new 1000-MMR player in Rally and marks them provisional", () => {
    const info = mmrToTier(1000, 0, RD_START);
    expect(info.tier).toBe("Rally");
    expect(info.provisional).toBe(true);
  });

  it("is no longer provisional once a player is calibrated", () => {
    const info = mmrToTier(1000, 50, RD_FLOOR);
    expect(info.provisional).toBe(false);
  });

  it("maps low MMR to Fledgling and high MMR to Legend with no division", () => {
    expect(mmrToTier(850, 50, RD_FLOOR).tier).toBe("Fledgling");
    const legend = mmrToTier(1600, 50, RD_FLOOR);
    expect(legend.tier).toBe("Legend");
    expect(legend.division).toBeNull();
  });

  it("assigns divisions within a tier band", () => {
    expect(mmrToTier(1350, 50, RD_FLOOR).tier).toBe("Champion"); // exactly on the Champion floor
    expect(mmrToTier(1210, 50, RD_FLOOR).division).toBe("III"); // just above the Ace floor
  });
});

describe("flagSuspiciousActivity", () => {
  it("flags nothing for ordinary play", () => {
    const flags = flagSuspiciousActivity({
      accountId: 1,
      recentMeetingsWithSameOpponent: 1,
      matchesInLastHour: 2,
      claimedLevel: "C",
      mmr: 1000,
    });
    expect(flags).toHaveLength(0);
  });

  it("flags repeated same-opponent meetings and a level/MMR mismatch", () => {
    const flags = flagSuspiciousActivity({
      accountId: 1,
      recentMeetingsWithSameOpponent: 6,
      matchesInLastHour: 2,
      claimedLevel: "E", // claims weakest level
      mmr: 1400, // but plays like the strongest
    });
    expect(flags.some((f) => f.includes("opponent"))).toBe(true);
    expect(flags.some((f) => f.includes("Declared level"))).toBe(true);
  });
});

describe("rateMatch -- eligibility", () => {
  it("refuses to rate a match where any player is in chill mode", () => {
    const result = rateMatch({
      team1: [calibrated(1000), calibrated(1000)],
      team2: [calibrated(1000), calibrated(1000, { playingMode: "chill" })],
      score1: 21,
      score2: 15,
    });
    expect(result.rated).toBe(false);
    expect(result.results).toHaveLength(0);
  });

  it("refuses to rate a tied score", () => {
    const result = rateMatch({
      team1: [calibrated(1000), calibrated(1000)],
      team2: [calibrated(1000), calibrated(1000)],
      score1: 20,
      score2: 20,
    });
    expect(result.rated).toBe(false);
  });

  it("skips guest players (no accountId) when writing results, but still uses their MMR in the math", () => {
    const result = rateMatch({
      team1: [calibrated(1000), calibrated(1000)],
      team2: [calibrated(1000), { ...calibrated(1000), accountId: null }], // a guest teammate
      score1: 21,
      score2: 15,
    });
    expect(result.rated).toBe(true);
    // 3 accounted players total (one guest on team2 excluded from results)
    expect(result.results).toHaveLength(3);
  });
});

describe("rateMatch -- worked examples (design doc section 4, calibrated players)", () => {
  // These correspond 1:1 to the five scenarios in the design doc and to the
  // request's required examples 1-5. Teammates are symmetric (same MMR as
  // each other) so each player's own change is easy to isolate and compare.

  it("Example 1: 1000 vs 1000, winner 21-18 -> modest, equal-magnitude change", () => {
    const result = rateMatch({
      team1: [calibrated(1000), calibrated(1000)],
      team2: [calibrated(1000), calibrated(1000)],
      score1: 21,
      score2: 18,
    });
    const winner = result.results.find((r) => r.won)!;
    const loser = result.results.find((r) => !r.won)!;
    expect(winner.mmrChange).toBeGreaterThan(0);
    expect(loser.mmrChange).toBeLessThan(0);
    expect(winner.mmrChange).toBe(-loser.mmrChange); // symmetric at equal MMR
    expect(Math.abs(winner.mmrChange)).toBeLessThan(25); // modest, not an explosive swing
  });

  it("Example 2 (A): 1000 vs 1000 -> roughly equal gain/loss, order of ~18", () => {
    const result = rateMatch({
      team1: [calibrated(1000), calibrated(1000)],
      team2: [calibrated(1000), calibrated(1000)],
      score1: 21,
      score2: 17,
    });
    const winner = result.results.find((r) => r.won)!;
    expect(winner.mmrChange).toBeGreaterThanOrEqual(10);
    expect(winner.mmrChange).toBeLessThanOrEqual(25);
  });

  it("Example (B): 1000 vs 1200, the 1000-side wins (upset) -> big gain for the upset winner", () => {
    const result = rateMatch({
      team1: [calibrated(1000), calibrated(1000)],
      team2: [calibrated(1200), calibrated(1200)],
      score1: 21,
      score2: 18,
    });
    const upsetWinner = result.results.find((r) => r.previousMmr === 1000)!;
    const favoriteLoser = result.results.find((r) => r.previousMmr === 1200)!;
    expect(upsetWinner.won).toBe(true);
    expect(upsetWinner.expectedWinProbability).toBeLessThan(0.5);
    expect(upsetWinner.mmrChange).toBeGreaterThan(20); // bigger than the equal-MMR case
    expect(favoriteLoser.mmrChange).toBeLessThan(0);
  });

  it("Example (C): 1000 vs 1400, the 1000-side wins (big upset) -> even bigger gain", () => {
    const resultB = rateMatch({
      team1: [calibrated(1000), calibrated(1000)],
      team2: [calibrated(1200), calibrated(1200)],
      score1: 21,
      score2: 18,
    });
    const resultC = rateMatch({
      team1: [calibrated(1000), calibrated(1000)],
      team2: [calibrated(1400), calibrated(1400)],
      score1: 21,
      score2: 18,
    });
    const gainB = resultB.results.find((r) => r.previousMmr === 1000)!.mmrChange;
    const gainC = resultC.results.find((r) => r.previousMmr === 1000)!.mmrChange;
    expect(gainC).toBeGreaterThan(gainB); // beating a 1400 is worth more than beating a 1200
  });

  it("Example (D): 1200 vs 1000, the 1200-side wins (expected) -> small gain", () => {
    const result = rateMatch({
      team1: [calibrated(1200), calibrated(1200)],
      team2: [calibrated(1000), calibrated(1000)],
      score1: 21,
      score2: 18,
    });
    const favoriteWinner = result.results.find((r) => r.previousMmr === 1200)!;
    expect(favoriteWinner.expectedWinProbability).toBeGreaterThan(0.5);
    expect(favoriteWinner.mmrChange).toBeGreaterThan(0);
    expect(favoriteWinner.mmrChange).toBeLessThan(15); // small reward for an expected result
  });

  it("Example (E): 1400 vs 1000, the 1400-side wins (strongly expected) -> very small gain", () => {
    const resultD = rateMatch({
      team1: [calibrated(1200), calibrated(1200)],
      team2: [calibrated(1000), calibrated(1000)],
      score1: 21,
      score2: 18,
    });
    const resultE = rateMatch({
      team1: [calibrated(1400), calibrated(1400)],
      team2: [calibrated(1000), calibrated(1000)],
      score1: 21,
      score2: 18,
    });
    const gainD = resultD.results.find((r) => r.previousMmr === 1200)!.mmrChange;
    const gainE = resultE.results.find((r) => r.previousMmr === 1400)!.mmrChange;
    expect(gainE).toBeLessThan(gainD); // the more overwhelming favorite gains even less
    expect(gainE).toBeGreaterThanOrEqual(0);
  });

  it("Request example 3: 1000 vs 1200, the 1000-side LOSES 19-21 -> small, protected loss", () => {
    const result = rateMatch({
      team1: [calibrated(1000), calibrated(1000)],
      team2: [calibrated(1200), calibrated(1200)],
      score1: 19,
      score2: 21,
    });
    const underdogLoser = result.results.find((r) => r.previousMmr === 1000)!;
    expect(underdogLoser.won).toBe(false);
    expect(underdogLoser.mmrChange).toBeLessThan(0);
    expect(Math.abs(underdogLoser.mmrChange)).toBeLessThan(10); // close loss to a stronger team barely costs anything
  });

  it("Request example 4: 1000 vs 1400, the 1000-side wins 21-15 -> large gain, big upset", () => {
    const result = rateMatch({
      team1: [calibrated(1000), calibrated(1000)],
      team2: [calibrated(1400), calibrated(1400)],
      score1: 21,
      score2: 15,
    });
    const upsetWinner = result.results.find((r) => r.previousMmr === 1000)!;
    expect(upsetWinner.mmrChange).toBeGreaterThan(25);
  });

  it("Request example 5: 1400 vs 1000, the 1400-side wins 21-10 -> small gain despite the big margin", () => {
    const result = rateMatch({
      team1: [calibrated(1400), calibrated(1400)],
      team2: [calibrated(1000), calibrated(1000)],
      score1: 21,
      score2: 10,
    });
    const favoriteWinner = result.results.find((r) => r.previousMmr === 1400)!;
    // Margin is huge (21-10) but dampened hard because the result was expected --
    // this is the "21-0 shouldn't explode the rating" requirement in action.
    expect(favoriteWinner.mmrChange).toBeLessThan(10);
  });
});

describe("rateMatch -- new-player calibration", () => {
  it("a brand-new player's rating moves much faster than a calibrated player's, for the same result", () => {
    const freshResult = rateMatch({
      team1: [freshPlayer(1000), freshPlayer(1000)],
      team2: [freshPlayer(1000), freshPlayer(1000)],
      score1: 21,
      score2: 18,
    });
    const calibratedResult = rateMatch({
      team1: [calibrated(1000), calibrated(1000)],
      team2: [calibrated(1000), calibrated(1000)],
      score1: 21,
      score2: 18,
    });
    const freshGain = freshResult.results.find((r) => r.won)!.mmrChange;
    const calibratedGain = calibratedResult.results.find((r) => r.won)!.mmrChange;
    expect(freshGain).toBeGreaterThan(calibratedGain * 3); // dramatically faster calibration
  });

  it("RD shrinks after the match, so a second identical match would move less", () => {
    const result = rateMatch({
      team1: [freshPlayer(1000), freshPlayer(1000)],
      team2: [freshPlayer(1000), freshPlayer(1000)],
      score1: 21,
      score2: 18,
    });
    const winner = result.results.find((r) => r.won)!;
    expect(winner.newRatingDeviation).toBeLessThan(winner.previousRatingDeviation);
  });
});

describe("rateMatch -- doubles distribution", () => {
  it("teammates with different MMR get different changes for the same win", () => {
    const result = rateMatch({
      team1: [calibrated(900), calibrated(1300)], // a mismatched but winning pair
      team2: [calibrated(1100), calibrated(1100)],
      score1: 21,
      score2: 18,
    });
    const weakerWinner = result.results.find((r) => r.previousMmr === 900)!;
    const strongerWinner = result.results.find((r) => r.previousMmr === 1300)!;
    // The weaker player was less individually favored, so an upset-flavored win
    // for them specifically should be worth more than for their stronger partner.
    expect(weakerWinner.mmrChange).toBeGreaterThan(strongerWinner.mmrChange);
  });

  it("a strong player gains little from being carried by a much weaker teammate", () => {
    const result = rateMatch({
      team1: [calibrated(1400), calibrated(700)], // strong player carried by a weak teammate
      team2: [calibrated(1000), calibrated(1000)],
      score1: 21,
      score2: 19,
    });
    const strongWinner = result.results.find((r) => r.previousMmr === 1400)!;
    expect(strongWinner.mmrChange).toBeGreaterThanOrEqual(0);
    expect(strongWinner.mmrChange).toBeLessThan(15); // small, since 1400 was individually favored regardless
  });
});

describe("rateMatch -- anti-farming dampening", () => {
  it("reduces the rating change for a player who just keeps beating the same opponent", () => {
    const freshMeeting = rateMatch({
      team1: [calibrated(1000, { recentMeetingsWithOpponents: 0 }), calibrated(1000, { recentMeetingsWithOpponents: 0 })],
      team2: [calibrated(700), calibrated(700)],
      score1: 21,
      score2: 10,
    });
    const repeatedMeeting = rateMatch({
      team1: [calibrated(1000, { recentMeetingsWithOpponents: 6 }), calibrated(1000, { recentMeetingsWithOpponents: 6 })],
      team2: [calibrated(700), calibrated(700)],
      score1: 21,
      score2: 10,
    });
    const freshGain = freshMeeting.results[0].mmrChange;
    const repeatedGain = repeatedMeeting.results[0].mmrChange;
    expect(repeatedGain).toBeLessThanOrEqual(freshGain);
  });
});

describe("determinism", () => {
  it("produces byte-identical output for identical input, called twice", () => {
    const input = {
      team1: [calibrated(1050), calibrated(980)] as [RatedPlayer, RatedPlayer],
      team2: [calibrated(1120), calibrated(990)] as [RatedPlayer, RatedPlayer],
      score1: 21,
      score2: 16,
    };
    const first = rateMatch(input);
    const second = rateMatch(input);
    expect(first).toEqual(second);
  });
});
