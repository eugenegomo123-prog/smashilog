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
  change needs a new migration via `npx drizzle-kit generate --name <slug>` (outputs to `db/migrations/`), then
  `npm run db:push` to apply it.

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
- `auth.ts` — host sessions are a signed token (HMAC of an expiry timestamp, keyed by the `HOST_PASSWORD`
  secret, computed with the Web Crypto API), not a database-backed session. This means rotating `HOST_PASSWORD`
  invalidates all outstanding host tokens instantly, and there's nothing to clean up server-side. Every function
  here is `async` because Web Crypto's `subtle` API is promise-based.

## Data model notes

- `matches.team1` / `team2` are stored as JSONB arrays of player IDs (`[id, id]`), not join rows — there are
  never more than 2 players per team so a normalized join table would add cost with no query benefit here.
- `sessions.courtLabels` is a JSONB array of strings, kept in sync with `courtCount` by the host settings tab.
  `regenerate.ts` matches courts by label, so renaming a court mid-session doesn't lose in-progress matches
  (they're already tied to a match row, not to the label list).
- Player identity is just a row ID stored in the participant's `localStorage` — there is no login. See
  "Known simplifications" below.

## Known simplifications vs. the original spec (intentional, flagged for follow-up)

- **No per-player identity check**: anyone with a participant's `localStorage` player ID (or who inspects
  network requests) could act as that player. The original spec flagged this as a stretch goal (PIN/device
  token). Fine for a casual club session; revisit before using this for anything with stakes.
- **No QR check-in**: joining is by URL (`/join/:sessionId`) rather than an in-app scanner. The host can share
  that URL directly; adding an actual QR code image would just be a client-side rendering of that same URL.
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
