// Auto queue planner -- the "brain" behind the host's Auto queue switch.
//
// Everything in this file is a pure function: no database, no network, no clock
// (the current time is always passed in). It reads a snapshot of one session
// -- who is playing, which matches are finished / on court / waiting in the
// queue -- and answers three questions:
//
//   1. planAutoQueue()        -- which auto-planned matches in the queue are no
//                                longer valid (drop them), and which new
//                                matches should be added to keep the queue
//                                topped up?
//   2. selectMatchesToStart() -- when a court frees up, which queued matches
//                                may actually go on court right now?
//   3. computeRestState()     -- who has played too many games in a row?
//                                (the building block both of the above use)
//
// Keeping it free of I/O is what makes it testable (see autoqueue.test.ts) and
// lets worker/index.ts + worker/lib/queue.ts stay thin: they load the rows, call
// in here, then apply the answer to the database.
//
// The rules it follows, in priority order (the same order the rest of the app
// uses -- skill first, see matchmaking.ts):
//
//   * NEAREST LEVEL.  Within a match, players are chosen for the closest levels
//     and the teams are balanced, using matchmaking.ts's own comparison
//     (compareMetrics / bestSplit) -- this file does not
//     re-implement that. A match that would grade Uneven or Poor is avoided
//     when someone else in line can make a better one (the "level guard").
//   * FAIR GAMES.     Whoever has the fewest games -- counting games already
//     finished, the one on court, and ones already waiting in the queue -- is
//     picked first. This is what stops the same mid-level players going out
//     again and again while the rest barely play.
//   * REST.           A player who has played two games in a row must sit out
//     at least the next match (MAX_IN_A_ROW / REST_STARTS below), as long as
//     there are enough other players to fill the court. With too few players
//     the rule bends rather than leaving a court empty.
//   * SHUFFLE.        Partners and opponents already used -- including ones in
//     matches that are on court or queued -- count as repeats, so variety is
//     spread across the plan. Level still comes before variety, as everywhere
//     else in the app.
//
// LOOK-AHEAD.  A queued match is allowed to include players who are still on
// court, as long as they will be free by the time that match would start. To
// know that, the planner assumes matches finish in the order they started
// (the one that has been on longest finishes first). That guess is sometimes
// wrong -- real games vary in length -- which is why (a) a court always takes
// whichever queued match is actually ready (see selectMatchesToStart), and
// (b) the plan is re-checked every time a match finishes. It is a best-effort
// forecast, never a promise.
//
// HOW WELL IT WORKS.  Checked on mock 3-hour sessions (40 random runs per group
// size, match lengths 12-22 minutes) driven through this exact code. With 16-24
// players on 3-4 courts the gap between the most- and least-played player
// averaged about 2 games (about 8 when the top suggestion is simply accepted
// every time, as the host does today), and nobody was given a third game in a
// row. With fewer than about 4 spare players beyond the courts the look-ahead is
// switched off (SMALL mode below) and both fairness and the rest rule loosen,
// because there is nobody to swap in.

import {
  bestSplit,
  compareMetrics,
  matchQuality,
  type PairHistory,
  type PlayerForMatchmaking,
  type SuggestedSplit,
  type MatchMetrics,
} from "./matchmaking";

// ---------------------------------------------------------------------------
// The tunable rules. Kept as named constants (rather than buried in the code)
// so the behaviour can be adjusted in one place and the tests can refer to them.
// ---------------------------------------------------------------------------

// A player may play this many games in a row; the next one has to wait.
export const MAX_IN_A_ROW = 2;

// How much "sitting out" resets the in-a-row count: this many matches have to
// START while the player is free and not in them. 1 = "sit out the next match".
// (A stricter "sit out a whole round" would be the number of courts instead --
// only workable with roughly 8 players per court.)
export const REST_STARTS = 1;

// The queue is planned this many rounds (one round = one match per court) ahead,
// never fewer than MIN_QUEUE_TARGET matches, and never above the caller's cap
// (queue.ts's MAX_QUEUE_LENGTH).
export const LOOKAHEAD_ROUNDS = 2;
export const MIN_QUEUE_TARGET = 2;
export const DEFAULT_MAX_QUEUE_LENGTH = 8;

// Full look-ahead needs at least this many players waiting off court (active
// players minus 4 per court); with fewer, nobody can be rested without leaving
// a court empty, so the planner only uses players who are free right now.
export const SPARE_PLAYERS_FOR_LOOKAHEAD = 4;

// Only the SHORTLIST_SIZE players with the fewest games are considered for a
// slot -- plenty to find a close-level match, and it keeps the search small.
const SHORTLIST_SIZE = 12;

// Level guard: if the best match for the player with the fewest games would
// grade Uneven/Poor, try the next few players in line instead -- unless that
// player has already been passed over for this many rounds of match starts.
const LEVEL_GUARD_ALTERNATIVES = 3;
const LEVEL_GUARD_PATIENCE_ROUNDS = 2;

const PLAYERS_PER_MATCH = 4;

// ---------------------------------------------------------------------------
// Input / output shapes -- plain data, deliberately independent of the database
// row types so this file has no imports beyond matchmaking.ts.
// ---------------------------------------------------------------------------

export interface AutoPlayerInput {
  id: number;
  level: string; // A-E
  approved: boolean;
  status: string; // active | resting | inactive -- only "active" players are planned
  preferredPartnerId?: number | null;
  // Passed straight through to the matching engine (it does not use them for
  // choosing a match today, but its player type carries them).
  currentStreak?: number;
  pointsFor?: number;
  pointsAgainst?: number;
  // Extra games credited so a late arrival / returning player counts as having
  // played about as much as everyone else (set by the server, 0 when unused).
  gamesBaseline?: number;
}

export interface AutoMatchInput {
  id: number;
  status: string; // completed | ongoing | queued -- anything else is ignored
  team1: number[];
  team2: number[];
  startedAt: Date | string | number | null; // real start time for ongoing / completed
  endedAt: Date | string | number | null;
  queuePosition: number | null; // only meaningful while queued (0 = front)
  auto: boolean; // true = planned by this file, false = built by the host
}

export interface AutoQueueInput {
  players: AutoPlayerInput[];
  matches: AutoMatchInput[]; // every match of the session
  courtCount: number;
  now: number; // epoch ms
  maxQueueLength?: number;
}

export interface PlannedMatch {
  team1: [number, number];
  team2: [number, number];
}

// FULL  = look ahead: queued matches may include players still on court.
// SMALL = too few spare players: only players who are free right now are used.
export type LookaheadMode = "full" | "small";

export interface AutoQueuePlan {
  // Queued AUTO match ids that are no longer valid and should be removed.
  // Host-built (manual) matches are never listed here.
  drop: number[];
  // New matches to append to the end of the queue, in order.
  add: PlannedMatch[];
  mode: LookaheadMode;
}

export interface RestInfo {
  // Games played in a row without a rest (0 = rested / not playing).
  streak: number;
  // Matches that started while this player was free and not in them, since
  // their last game ended.
  idle: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toMs(v: Date | string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function idsOfMatch(m: { team1: number[]; team2: number[] }): number[] {
  return [...m.team1, ...m.team2];
}

function byQueueOrder(a: AutoMatchInput, b: AutoMatchInput): number {
  return (a.queuePosition ?? 0) - (b.queuePosition ?? 0) || a.id - b.id;
}

// Level letters A-E as 0-4 (A best). Only used to cheaply skip candidate groups
// that cannot win on skill spread; matchmaking.ts still does the real scoring.
function levelIndex(level: string): number {
  const i = "ABCDE".indexOf(level);
  return i < 0 ? 2 : i; // unknown letters count as C, same as matchmaking.ts
}

// How many matches the queue should hold, and which look-ahead mode applies.
export function queueTargetLength(courtCount: number, maxQueueLength = DEFAULT_MAX_QUEUE_LENGTH): number {
  const courts = Math.max(1, Math.floor(courtCount) || 1);
  return Math.min(maxQueueLength, Math.max(MIN_QUEUE_TARGET, LOOKAHEAD_ROUNDS * courts));
}

export function lookaheadModeFor(activePlayerCount: number, courtCount: number): LookaheadMode {
  const courts = Math.max(1, Math.floor(courtCount) || 1);
  return activePlayerCount >= PLAYERS_PER_MATCH * courts + SPARE_PLAYERS_FOR_LOOKAHEAD ? "full" : "small";
}

function isPlayable(p: AutoPlayerInput): boolean {
  return p.approved && p.status === "active";
}

// ---------------------------------------------------------------------------
// Rest state: who has played too many games in a row?
//
// Walk every match that has started (finished ones and ones on court) in the
// order they started. For each match start:
//   * players in the match: one more game in a row, and they are busy until it
//     ends;
//   * players NOT in it who are free at that moment: they were passed over, so
//     idle goes up -- and once that reaches REST_STARTS their in-a-row count
//     resets to 0 (they have rested);
//   * players on court elsewhere are untouched (they could not have played it).
// ---------------------------------------------------------------------------

export function computeRestState(playerIds: number[], matches: AutoMatchInput[]): Map<number, RestInfo> {
  const started = matches
    .filter((m) => m.status === "ongoing" || (m.status === "completed" && toMs(m.endedAt) !== null))
    .map((m) => ({
      m,
      start: toMs(m.startedAt) ?? 0,
      // A match still on court keeps its players busy for the rest of the walk.
      end: m.status === "completed" ? (toMs(m.endedAt) as number) : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.start - b.start || a.m.id - b.m.id);

  const info = new Map<number, RestInfo>();
  const freeAt = new Map<number, number>();
  for (const id of playerIds) {
    info.set(id, { streak: 0, idle: 0 });
    freeAt.set(id, Number.NEGATIVE_INFINITY);
  }

  for (const { m, start, end } of started) {
    const inMatch = new Set(idsOfMatch(m));
    for (const id of playerIds) {
      const st = info.get(id) as RestInfo;
      if (inMatch.has(id)) {
        st.streak += 1;
        st.idle = 0;
        freeAt.set(id, end);
      } else if ((freeAt.get(id) as number) <= start) {
        st.idle += 1;
        if (st.idle >= REST_STARTS) st.streak = 0;
      }
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// Pair history (who has partnered / opposed whom), including matches that are
// on court or planned -- regenerate.ts's buildPairHistory only sees finished
// matches, which is right for suggestions but would let the planner repeat a
// pairing it has already queued.
// ---------------------------------------------------------------------------

function emptyHistory(): PairHistory {
  return {
    partnerCounts: new Map(),
    opponentCounts: new Map(),
    lastPartnerOf: new Map(),
    lastOpponentOf: new Map(),
    groupCounts: new Map(),
    justPlayedIds: new Set(),
  };
}

function cloneHistory(h: PairHistory): PairHistory {
  return {
    partnerCounts: new Map(h.partnerCounts),
    opponentCounts: new Map(h.opponentCounts),
    lastPartnerOf: new Map(h.lastPartnerOf),
    lastOpponentOf: new Map(h.lastOpponentOf),
    groupCounts: new Map(h.groupCounts),
    justPlayedIds: new Set(h.justPlayedIds),
  };
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// Same bookkeeping as regenerate.ts's buildPairHistory, one match at a time;
// the most recent match wins for "last partner / last opponent".
function recordMatch(h: PairHistory, team1: number[], team2: number[]) {
  if (team1.length !== 2 || team2.length !== 2) return;
  bump(h.partnerCounts, pairKey(team1[0], team1[1]));
  bump(h.partnerCounts, pairKey(team2[0], team2[1]));
  h.lastPartnerOf.set(team1[0], team1[1]);
  h.lastPartnerOf.set(team1[1], team1[0]);
  h.lastPartnerOf.set(team2[0], team2[1]);
  h.lastPartnerOf.set(team2[1], team2[0]);
  for (const a of team1) for (const b of team2) bump(h.opponentCounts, pairKey(a, b));
  for (const p of team1) h.lastOpponentOf.set(p, team2[0]);
  for (const p of team2) h.lastOpponentOf.set(p, team1[0]);
  bump(h.groupCounts, [...team1, ...team2].sort((x, y) => x - y).join(","));
}

// ---------------------------------------------------------------------------
// The projection -- a running picture of "how things will stand" as the queue is
// walked slot by slot (slot 0 = the next match to start, slot 1 = the one after,
// ...). Slot j is assumed to start when the j-th court becomes free.
// ---------------------------------------------------------------------------

interface Projection {
  streak: Map<number, number>; // games in a row so far
  idle: Map<number, number>; // match starts passed over since the last game
  // Slot number AFTER which the player is free again. Missing = free right now.
  // A player in the k-th-oldest match on court is free from slot (free courts + k);
  // a player placed in slot j is free again from slot (courts + j).
  endRank: Map<number, number>;
  eff: Map<number, number>; // games "counted" for fairness: finished + on court + queued + baseline
  history: PairHistory;
}

function cloneProjection(p: Projection): Projection {
  return {
    streak: new Map(p.streak),
    idle: new Map(p.idle),
    endRank: new Map(p.endRank),
    eff: new Map(p.eff),
    history: cloneHistory(p.history),
  };
}

interface Env {
  courts: number;
  now: number;
  mode: LookaheadMode;
  activeIds: number[]; // sorted ascending, so every loop below is deterministic
  activeSet: Set<number>;
  byId: Map<number, AutoPlayerInput>;
  lastEnded: Map<number, number>; // when each player's most recent finished game ended
}

function buildEnv(input: AutoQueueInput): Env {
  const courts = Math.max(1, Math.floor(input.courtCount) || 1);
  const active = input.players.filter(isPlayable);
  const activeIds = active.map((p) => p.id).sort((a, b) => a - b);

  const lastEnded = new Map<number, number>();
  for (const m of input.matches) {
    if (m.status !== "completed") continue;
    const end = toMs(m.endedAt);
    if (end === null) continue;
    for (const id of idsOfMatch(m)) lastEnded.set(id, Math.max(lastEnded.get(id) ?? end, end));
  }

  return {
    courts,
    now: input.now,
    mode: lookaheadModeFor(active.length, courts),
    activeIds,
    activeSet: new Set(activeIds),
    byId: new Map(input.players.map((p) => [p.id, p])),
    lastEnded,
  };
}

// The starting picture, before any queued match is considered: finished games,
// whoever is on court, current streaks.
function buildBaseProjection(input: AutoQueueInput, env: Env): Projection {
  const rest = computeRestState(env.activeIds, input.matches);
  const streak = new Map<number, number>();
  const idle = new Map<number, number>();
  rest.forEach((st, id) => {
    streak.set(id, st.streak);
    idle.set(id, st.idle);
  });

  const completed = input.matches
    .filter((m) => m.status === "completed" && toMs(m.endedAt) !== null)
    .sort((a, b) => (toMs(a.endedAt) as number) - (toMs(b.endedAt) as number) || a.id - b.id);
  const ongoing = input.matches
    .filter((m) => m.status === "ongoing")
    .sort((a, b) => (toMs(a.startedAt) ?? 0) - (toMs(b.startedAt) ?? 0) || a.id - b.id);

  const eff = new Map<number, number>();
  for (const p of input.players) eff.set(p.id, Math.max(0, p.gamesBaseline ?? 0));
  const history = emptyHistory();
  for (const m of completed) {
    for (const id of idsOfMatch(m)) eff.set(id, (eff.get(id) ?? 0) + 1);
    recordMatch(history, m.team1, m.team2);
  }

  const freeCourts = Math.max(0, env.courts - ongoing.length);
  const endRank = new Map<number, number>();
  ongoing.forEach((m, k) => {
    for (const id of idsOfMatch(m)) {
      endRank.set(id, freeCourts + k);
      eff.set(id, (eff.get(id) ?? 0) + 1);
    }
    recordMatch(history, m.team1, m.team2);
  });

  return { streak, idle, endRank, eff, history };
}

// Put a match into slot `slot`: its players take one more game in a row and are
// busy until a full round later; everyone else who is free at that moment was
// passed over (idle goes up, and enough of that resets their streak).
function advanceSlot(pr: Projection, env: Env, slot: number, team1: number[], team2: number[]) {
  const chosen = new Set(idsOfMatch({ team1, team2 }));
  for (const id of env.activeIds) {
    if (chosen.has(id)) {
      pr.streak.set(id, (pr.streak.get(id) ?? 0) + 1);
      pr.idle.set(id, 0);
      pr.endRank.set(id, env.courts + slot);
      pr.eff.set(id, (pr.eff.get(id) ?? 0) + 1);
    } else if (isAvailable(pr, id, slot, env.mode)) {
      const idle = (pr.idle.get(id) ?? 0) + 1;
      pr.idle.set(id, idle);
      if (idle >= REST_STARTS) pr.streak.set(id, 0);
    }
  }
  recordMatch(pr.history, team1, team2);
}

// Can this player be placed in `slot`?  FULL mode: yes if they will be free by
// then. SMALL mode: only if they are neither on court nor already in the queue.
function isAvailable(pr: Projection, id: number, slot: number, mode: LookaheadMode): boolean {
  if (mode === "small") return !pr.endRank.has(id);
  return (pr.endRank.get(id) ?? -1) <= slot;
}

function countRestedAvailable(pr: Projection, env: Env, slot: number): number {
  let n = 0;
  for (const id of env.activeIds) {
    if (isAvailable(pr, id, slot, env.mode) && (pr.streak.get(id) ?? 0) < MAX_IN_A_ROW) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Walking the existing queue: find the first auto match that is no longer valid.
// ---------------------------------------------------------------------------

function findInvalidAutoMatch(
  base: Projection,
  env: Env,
  queue: AutoMatchInput[],
): { index: number; pr: Projection } {
  const pr = cloneProjection(base);
  for (let j = 0; j < queue.length; j++) {
    const m = queue[j];
    const ids = idsOfMatch(m);
    if (m.auto) {
      // (a) someone in it is resting / inactive / removed.
      if (ids.some((id) => !env.activeSet.has(id))) return { index: j, pr };
      // (b) someone would play a third game in a row, and there are enough
      //     rested players to make a match without them.
      const capped = ids.some((id) => (pr.streak.get(id) ?? 0) >= MAX_IN_A_ROW);
      if (capped && countRestedAvailable(pr, env, j) >= PLAYERS_PER_MATCH) return { index: j, pr };
    }
    advanceSlot(pr, env, j, m.team1, m.team2);
  }
  return { index: -1, pr };
}

// ---------------------------------------------------------------------------
// Picking one new match for a slot.
// ---------------------------------------------------------------------------

interface Candidate {
  four: PlayerForMatchmaking[];
  split: SuggestedSplit & { metrics: MatchMetrics };
}

// Best match that includes `anchor`, trying every group of three others from
// `others`. Groups that cannot beat the best skill spread found so far are
// skipped without scoring -- exact, because skill spread is the first thing the
// engine compares.
function bestWithAnchor(
  anchor: PlayerForMatchmaking,
  others: PlayerForMatchmaking[],
  history: PairHistory,
  now: number,
): Candidate | null {
  const la = levelIndex(anchor.level);
  const lv = others.map((p) => levelIndex(p.level));
  let best: Candidate | null = null;
  let bestSpread = Number.POSITIVE_INFINITY;
  for (let a = 0; a < others.length - 2; a++) {
    for (let b = a + 1; b < others.length - 1; b++) {
      for (let c = b + 1; c < others.length; c++) {
        const hi = Math.max(la, lv[a], lv[b], lv[c]);
        const lo = Math.min(la, lv[a], lv[b], lv[c]);
        if (hi - lo > bestSpread) continue;
        const four = [anchor, others[a], others[b], others[c]];
        const split = bestSplit(four, history, now);
        if (best === null || compareMetrics(split.metrics, best.split.metrics) < 0) {
          best = { four, split };
          bestSpread = split.metrics.maxSkillSpread;
        }
      }
    }
  }
  return best;
}

function gradeIsAcceptable(c: Candidate): boolean {
  const g = matchQuality(
    [c.split.team1[0].level, c.split.team1[1].level],
    [c.split.team2[0].level, c.split.team2[1].level],
  ).grade;
  return g === "excellent" || g === "good" || g === "fair";
}

function toEnginePlayer(id: number, pr: Projection, env: Env): PlayerForMatchmaking {
  const p = env.byId.get(id) as AutoPlayerInput;
  // Someone on court or already planned counts as "just played" for the
  // wait-time tier; everyone else by when their last finished game ended.
  const lastEndedMs = pr.endRank.has(id) ? env.now : (env.lastEnded.get(id) ?? null);
  return {
    id,
    level: p.level,
    currentStreak: p.currentStreak ?? 0,
    pointsFor: p.pointsFor ?? 0,
    pointsAgainst: p.pointsAgainst ?? 0,
    gamesPlayed: pr.eff.get(id) ?? 0,
    lastMatchEndedAt: lastEndedMs === null ? null : new Date(lastEndedMs).toISOString(),
    preferredPartnerId: p.preferredPartnerId ?? null,
  };
}

// `allowRelax` says whether the rest rule may bend for this slot when there are
// not enough rested players. It may for the matches that start right now and
// whenever the look-ahead is off (SMALL mode: the picture is exact and there is
// no one else to use). It may NOT for matches further down the queue: those are
// forecasts, and a forecast built on bending the rule would likely never be
// needed -- it is better to leave the queue a little shorter for the moment and
// fill it in once the real situation is known.
function pickNextMatch(pr: Projection, env: Env, slot: number, allowRelax: boolean): PlannedMatch | null {
  const available = env.activeIds.filter((id) => isAvailable(pr, id, slot, env.mode));
  if (available.length < PLAYERS_PER_MATCH) return null;

  // Hard rule: nobody on their third game in a row -- unless there are not
  // enough rested players, in which case bring in the least-tired others.
  let eligible = available.filter((id) => (pr.streak.get(id) ?? 0) < MAX_IN_A_ROW);
  if (eligible.length < PLAYERS_PER_MATCH) {
    if (!allowRelax) return null;
    const tired = available
      .filter((id) => !eligible.includes(id))
      .sort(
        (a, b) =>
          (pr.streak.get(a) ?? 0) - (pr.streak.get(b) ?? 0) || (pr.eff.get(a) ?? 0) - (pr.eff.get(b) ?? 0) || a - b,
      );
    eligible = eligible.concat(tired.slice(0, PLAYERS_PER_MATCH - eligible.length));
  }

  // Fair games: fewest games first, then the player passed over the most.
  const inLine = [...eligible]
    .sort((a, b) => (pr.eff.get(a) ?? 0) - (pr.eff.get(b) ?? 0) || (pr.idle.get(b) ?? 0) - (pr.idle.get(a) ?? 0) || a - b)
    .slice(0, SHORTLIST_SIZE);

  // For the engine's soft "just came off a court" preference: anyone who has
  // played since their last rest.
  pr.history.justPlayedIds = new Set(env.activeIds.filter((id) => (pr.streak.get(id) ?? 0) >= 1));

  const pool = inLine.map((id) => toEnginePlayer(id, pr, env));
  let chosen = bestWithAnchor(pool[0], pool.slice(1), pr.history, env.now);

  // Level guard.
  if (chosen && !gradeIsAcceptable(chosen)) {
    const waitedRounds = pr.idle.get(inLine[0]) ?? 0;
    if (waitedRounds < LEVEL_GUARD_PATIENCE_ROUNDS * env.courts) {
      for (let ai = 1; ai <= LEVEL_GUARD_ALTERNATIVES && ai < pool.length; ai++) {
        const alt = bestWithAnchor(
          pool[ai],
          pool.filter((_, i) => i !== ai),
          pr.history,
          env.now,
        );
        if (alt && gradeIsAcceptable(alt)) {
          chosen = alt;
          break;
        }
      }
    }
  }
  if (!chosen) return null;
  return {
    team1: [chosen.split.team1[0].id, chosen.split.team1[1].id],
    team2: [chosen.split.team2[0].id, chosen.split.team2[1].id],
  };
}

// ---------------------------------------------------------------------------
// Public: plan the queue.
// ---------------------------------------------------------------------------

export function planAutoQueue(input: AutoQueueInput): AutoQueuePlan {
  const env = buildEnv(input);
  const base = buildBaseProjection(input, env);

  // 1. Repair: drop auto matches that stopped being valid, one at a time (each
  //    drop changes who is free for the matches behind it, so re-check).
  const queue = input.matches.filter((m) => m.status === "queued").sort(byQueueOrder);
  const drop: number[] = [];
  let live = queue;
  let pr: Projection;
  for (;;) {
    const found = findInvalidAutoMatch(base, env, live);
    pr = found.pr;
    if (found.index < 0) break;
    drop.push(live[found.index].id);
    live = live.filter((_, i) => i !== found.index);
  }

  // 2. Top up to the target length. Courts that are free right now are filled
  //    first; the rest-rule may bend only for those (see pickNextMatch).
  const target = queueTargetLength(env.courts, input.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH);
  const onCourt = input.matches.filter((m) => m.status === "ongoing").length;
  const startingNow = Math.max(0, env.courts - onCourt);
  const add: PlannedMatch[] = [];
  for (let slot = live.length; slot < target; slot++) {
    const next = pickNextMatch(pr, env, slot, env.mode === "small" || slot < startingNow);
    if (!next) break;
    add.push(next);
    advanceSlot(pr, env, slot, next.team1, next.team2);
  }

  return { drop, add, mode: env.mode };
}

// ---------------------------------------------------------------------------
// Public: which queued matches may go on court right now?
//
// This replaces the "first queued match whose players are all free" loop in
// queue.ts when Auto queue is ON (with `enforceRest` false it behaves exactly
// like that loop does today). In order, for each open court it takes the first
// queued match that is:
//   * valid   -- every player is approved + active, and
//   * ready   -- nobody in it is still on court, and
//   * (auto matches only) rested -- nobody would be on a third game in a row,
//     unless there are not enough rested players free to do better.
// A match that fails the rest check, or any other check, is simply skipped and
// stays in the queue (as unready matches do today). If it is the next one in
// line, planAutoQueue()'s repair step -- which runs right after, using the same
// rule -- removes it and plans a replacement.
//
// The rest rule only bends when fewer than 4 rested players are free to make a
// match at all -- earmarks for other queued matches do not count as an excuse,
// because that is how a third game in a row would slip through.
// ---------------------------------------------------------------------------

export interface StartSelection {
  start: number[]; // queued match ids to put on court, in the order to fill courts
}

export function selectMatchesToStart(args: {
  players: AutoPlayerInput[];
  matches: AutoMatchInput[];
  openCourts: number;
  enforceRest: boolean;
}): StartSelection {
  const { matches, openCourts, enforceRest } = args;
  const result: StartSelection = { start: [] };
  if (openCourts <= 0) return result;

  const byId = new Map(args.players.map((p) => [p.id, p]));
  const activeIds = args.players.filter(isPlayable).map((p) => p.id).sort((a, b) => a - b);

  const busy = new Set<number>();
  for (const m of matches) if (m.status === "ongoing") for (const id of idsOfMatch(m)) busy.add(id);

  const rest = enforceRest ? computeRestState(activeIds, matches) : new Map<number, RestInfo>();
  const queue = matches.filter((m) => m.status === "queued").sort(byQueueOrder);

  for (const m of queue) {
    if (result.start.length >= openCourts) break;
    const ids = idsOfMatch(m);
    const valid = ids.every((id) => {
      const p = byId.get(id);
      return !!p && isPlayable(p);
    });
    if (!valid) continue;
    // Waiting on someone still on court: stays queued, as today.
    if (ids.some((id) => busy.has(id))) continue;

    if (enforceRest && m.auto) {
      const compliant = (id: number) => (rest.get(id)?.streak ?? 0) < MAX_IN_A_ROW;
      if (!ids.every(compliant)) {
        const restedFree = activeIds.filter((id) => !busy.has(id) && compliant(id));
        if (restedFree.length >= PLAYERS_PER_MATCH) continue;
      }
    }

    result.start.push(m.id);
    // Starting this match: its players are now busy and one game further in a
    // row; every other free player has been passed over once.
    const inMatch = new Set(ids);
    if (enforceRest) {
      for (const id of activeIds) {
        const st = rest.get(id);
        if (!st) continue;
        if (inMatch.has(id)) {
          st.streak += 1;
          st.idle = 0;
        } else if (!busy.has(id)) {
          st.idle += 1;
          if (st.idle >= REST_STARTS) st.streak = 0;
        }
      }
    }
    for (const id of ids) busy.add(id);
  }
  return result;
}
