# AGENTS.md

Guidance for AI agents (and humans) working on this codebase.

## Architecture

- **Frontend** (`src/`): React + Vite SPA, routed with `react-router-dom`. No global state library — each page
  fetches what it needs from `src/api.ts` and polls on an interval (`setInterval` inside `useEffect`) to stay
  reasonably live across devices. There is no websocket/realtime layer; if true realtime sync becomes a
  requirement, replace the polling in `HostSession.tsx` / `ParticipantSession.tsx` with a subscription.
- **Backend** (`worker/index.ts`): a single Cloudflare Worker, routed with Hono — one route per resource,
  including `:id` path params via `c.req.param()`. All matchmaking and stat calculations happen server-side;
  the client only ever sends scores, names, and level/status changes, and displays what the server returns.
  Secrets and bindings (the database URL, the host password, the static-assets binding) arrive per-request via
  `c.env` — there is no `process.env` in the Workers runtime, so nothing can be read at module load time; every
  handler that needs the database calls `getDb(c.env.DATABASE_URL)` itself.
- **Data** (`db/`): Drizzle ORM schema against Postgres (Neon), queried through `drizzle-orm/neon-http`.
  `db/schema.ts` is the single source of truth for the schema — never hand-write `CREATE TABLE` SQL. Any schema
  change needs `npm run db:push` (reads `DATABASE_URL` from `.env`) to apply it directly; only add a hand-written
  file under `db/migrations/` if you've actually run `drizzle-kit generate` to produce it (its metadata/snapshot
  files aren't safe to fabricate by hand).

## Key server-side modules (`worker/lib/`)

- `matchmaking.ts` — pure functions: priority sort (fewest games played, then longest rest) and the "pick the
  2v2 split that minimizes the rating gap" logic. No I/O; easy to unit test in isolation if tests are added.
- `regenerate.ts` — fills every open court in a session with a new match from the eligible pool. Called both by
  the host's manual "Regenerate queue" button and automatically right after a match is marked complete (so a
  freed court gets refilled without a host tap). Takes a `Db` instance as its first argument rather than
  importing one, since Workers don't have a module-scope database client (see Architecture above).
- `stats.ts` — `recomputeSessionStats` rebuilds every player's wins/losses/points/streak/games-played from the
  full completed-match history each time it's called, rather than patching deltas. This is deliberate: it's
  what makes "edit a past score" (a host control in the spec) correct with zero extra bookkeeping — see the
  comment in `stats.ts` before changing this to an incremental approach.
- `accountStats.ts` — the same "re-derive from source rows every time" philosophy as `stats.ts`, one level up:
  `computeOverallStats`/`computeHistory`/`computeRanking` all roll up the per-session `players` rows linked to
  an account (via `players.accountId`) rather than keeping a separate running total anywhere. If a session's
  stats get recomputed (e.g. after a score edit), every account-level view is automatically correct on its next
  read — nothing else needs to be told about the change.
- `auth.ts` — host sessions are a signed token (HMAC of an expiry timestamp, keyed by the `HOST_PASSWORD`
  secret, computed with the Web Crypto API), not a database-backed session. This means rotating `HOST_PASSWORD`
  invalidates all outstanding host tokens instantly, and there's nothing to clean up server-side. Every function
  here is `async` because Web Crypto's `subtle` API is promise-based. `createPlayerToken`/`verifyPlayerToken`/
  `requirePlayer` reuse the same secret and the same sign()/timingSafeEqual() helpers for player-account
  tokens, just with a different payload shape (`accountId.expiry` instead of a bare expiry) so the two kinds of
  token never cross-validate.
- `password.ts` — PBKDF2 (via `crypto.subtle.deriveBits`) password hashing for player accounts, since the
  Workers runtime has no bcrypt/argon2 available. Each password gets its own random salt.

## Data model notes

- `matches.team1` / `team2` are stored as JSONB arrays of player IDs (`[id, id]`), not join rows — there are
  never more than 2 players per team so a normalized join table would add cost with no query benefit here.
- `sessions.courtLabels` is a JSONB array of strings, kept in sync with `courtCount` by the host settings tab.
  `regenerate.ts` matches courts by label, so renaming a court mid-session doesn't lose in-progress matches
  (they're already tied to a match row, not to the label list).
- Player identity is normally just a row ID stored in the participant's `localStorage` (see `playerKey()` in
  `src/api.ts`) — there is no login for guests. See "Known simplifications" below.
- **Player accounts** (`accounts` table): a permanent login, independent of any one session. A `players` row
  (which is always session-scoped, as above) can optionally set `accountId` to link back to one. A registered
  player joining a session still gets a completely normal `players` row — same approval flow, same stats
  columns, same everything a guest gets — the only difference is that column being non-null. This is why
  `ParticipantSession.tsx` needed almost no changes: it already only cares about a `players` row id (`myId`);
  it just now resolves that id via an account lookup (`api.resolveMyPlayerId`) as a fallback when the
  localStorage key isn't set yet, in addition to the guest path.
- **Registration token** (`appConfig` table, single row): the value the host's sign-up QR code encodes as
  `${origin}/signup?token=...`. Not session-scoped — it's app-wide, since there's only one shared host identity
  in this app to begin with. Regenerating it (Host → Settings) overwrites the row, so any previously
  printed/displayed QR code stops working immediately.
- Assumptions baked into the account-stats views (`worker/lib/accountStats.ts`), worth revisiting if the spec
  is tightened up later:
  - "Total points" / ranking points = `pointsFor` (points the player's team scored), not point differential.
  - "Average score" = total points ÷ games played (points per game), not per-session average.
  - Monthly ranking groups sessions by their `createdAt` month, since sessions are effectively single-day
    events in this app; there's no per-match date granularity used for the month boundary.
  - There's no multi-host/named-host concept anywhere in the data model (one shared `HOST_PASSWORD`), so the
    "Join a Session" list has no "Host" column — only name and player count.

## Known simplifications vs. the original spec (intentional, flagged for follow-up)

- **No per-player identity check for guests**: anyone with a guest's `localStorage` player ID (or who inspects
  network requests) could act as that player. The original spec flagged this as a stretch goal (PIN/device
  token). Registered players get a real login, but a signed-in player token is still just a bearer token —
  there's no device binding beyond that. Fine for a casual club session; revisit before using this for anything
  with stakes.
- **No in-app QR scanner**: the registration "QR code" is just a link with a token in it; any phone's normal
  camera app can already scan and open it, so there was no need to add camera-permission/scanning code to the
  React app itself.
- **No true background push notifications**: in-session alerts ("you're up soon" / "you're up next") are an
  in-app toast + `navigator.vibrate`, which only fires while the tab is open, per the spec's explicit MVP
  carve-out. Real push (phone locked, app closed) needs a service worker + push provider.
- **No live realtime sync**: devices poll every 4-5 seconds rather than subscribing to push updates. Good
  enough for a courtside app where a few seconds of staleness is harmless; swap for Postgres LISTEN/NOTIFY or a
  realtime provider if that changes.

## Conventions

- Worker code imports from `db/` and between `worker/lib/` modules with plain extensionless relative paths
  (`../../db`, `./matchmaking`) — this is bundled by esbuild (via Wrangler/Vite), not run as raw Node ESM, so no
  `.js` extension is needed or expected.
- Column names in `db/schema.ts` are snake_case strings, TS field names are camelCase — follow the existing
  pattern for any new columns.
- Levels are the letters `A`-`E` (A best) everywhere in the UI and API; the only place they're mapped to a
  number is `matchmaking.ts`'s internal `LEVEL_SCORE`, which stays private to that module.
- `getDb()` (in `db/index.ts`) deliberately does not pass a `schema` option to `drizzle()` — this app only uses
  the plain query builder (`db.select()/.insert()/.update()/.delete()`), never the `db.query.*` relational API,
  which is the only thing that option is for.
- `playerKey()` (the guest/account localStorage key for "which players-row am I, in this session") lives in
  `src/api.ts` as the single source of truth; `ParticipantJoin.tsx` re-exports it for backwards compatibility
  with existing imports rather than duplicating it.
