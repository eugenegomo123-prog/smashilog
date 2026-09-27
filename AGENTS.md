# AGENTS.md

Guidance for AI agents (and humans) working on this codebase.

## Architecture

- **Frontend** (`src/`): React + Vite SPA, routed with `react-router-dom`. No global state library — each page
  fetches what it needs from `src/api.ts` and polls on an interval (`setInterval` inside `useEffect`) to stay
  reasonably live across devices. There is no websocket/realtime layer; if true realtime sync becomes a
  requirement, replace the polling in `HostSession.tsx` / `ParticipantSession.tsx` with a subscription.
- **Backend** (`worker/index.ts`): a single Cloudflare Worker, routed with Hono — one route per resource,
  including `:id` path params via `c.req.param()`. All matchmaking and stat calculations happen server-side;
  the client only ever sends scores, names, level/status changes, and match-building requests, and displays
  what the server returns. Secrets and bindings (the database URL, the host password, the static-assets
  binding) arrive per-request via `c.env` — there is no `process.env` in the Workers runtime, so nothing can be
  read at module load time; every handler that needs the database calls `getDb(c.env.DATABASE_URL)` itself.
- **Data** (`db/`): Drizzle ORM schema against Postgres (Neon), queried through `drizzle-orm/neon-http`.
  `db/schema.ts` is the single source of truth for the schema — never hand-write `CREATE TABLE` SQL. Any schema
  change needs a new migration via `npx drizzle-kit generate --name <slug>` (outputs to `db/migrations/`), then
  `npm run db:push` to apply it.

## The match queue model

Matches move through three states, all stored in the same `matches` table (`status` column — no schema change
needed to add a new one, since it's a plain text column, not a DB enum):

1. **`suggested`** — a proposed 2v2 matchup the matchmaking algorithm generated. Not tied to a real court yet
   (`courtLabel` is `""`). Purely a recommendation; several suggestions can (and usually do) share players,
   since only one of them will actually be picked. Regenerating replaces the whole batch.
2. **`ongoing`** — a real match in progress on a specific court. Created either by the host assigning a
   suggestion to a court (`POST /sessions/:id/assign-match`) or by building one manually (`POST
   /sessions/:id/custom-match`).
3. **`completed`** — has scores and an `endedAt`. Feeds `recomputeSessionStats` and the History tab.

Nothing happens automatically anymore: regenerating suggestions doesn't touch courts, and finishing a match
doesn't refill its court. The host always explicitly sends a suggestion (or a custom match) to a specific open
court from the Queue tab. This is deliberate — see the "Known MVP simplifications" note below on why the old
auto-fill-on-completion behavior was removed.

## Key server-side modules (`worker/lib/`)

- `matchmaking.ts` — pure functions: `sortByPriority` (fewest games played, then longest rest — also what keeps
  someone who just played from being suggested again right away, whenever there's someone else to rotate in)
  and `generateSuggestedMatches`, which builds up to 8 distinct suggested matchups from the eligible pool,
  balancing skill level per match (via `bestSplitAvoidingRepeats`) while nudging away from repeating either
  player's most recent partner. All best-effort — with a very small active pool, repeats become unavoidable and
  the functions fall back gracefully (see the "Pass 2" comment in `generateSuggestedMatches`) rather than
  erroring. No I/O; easy to unit test in isolation if tests are added.
- `regenerate.ts` — orchestrates the above with the database: pulls the eligible pool (approved, `status:
  "active"`, not already in an `ongoing` match), builds a "last partner" map from completed-match history, calls
  `generateSuggestedMatches`, deletes the old `suggested` rows for the session, and inserts the fresh batch.
  Called only by the host's "Regenerate" button — never automatically. Takes a `Db` instance as its first
  argument rather than importing one, since Workers don't have a module-scope database client (see Architecture
  above).
- `stats.ts` — `recomputeSessionStats` rebuilds every player's wins/losses/points/streak/games-played from the
  full completed-match history each time it's called, rather than patching deltas. This is what makes both
  "edit a past score" and "delete a match from history" (host controls) correct with zero extra bookkeeping —
  see the comment in `stats.ts` before changing this to an incremental approach. `playerIdsInOngoingMatches`
  only looks at `status === "ongoing"`, so it automatically ignores `suggested` rows with no extra filtering.
- `auth.ts` — host sessions are a signed token (HMAC of an expiry timestamp, keyed by the `HOST_PASSWORD`
  secret, computed with the Web Crypto API), not a database-backed session. This means rotating `HOST_PASSWORD`
  invalidates all outstanding host tokens instantly, and there's nothing to clean up server-side. Every function
  here is `async` because Web Crypto's `subtle` API is promise-based.

## Data model notes

- `matches.team1` / `team2` are stored as JSONB arrays of player IDs (`[id, id]`), not join rows — there are
  never more than 2 players per team so a normalized join table would add cost with no query benefit here. This
  holds for `suggested` rows too, even though they aren't tied to a real court.
- `matches.courtLabel` is `""` for `suggested` rows (unassigned) and a real label once `ongoing`/`completed`.
  It's `NOT NULL` in the schema, so `""` (not `null`) is used to represent "no court yet."
- `sessions.courtLabels` is a JSONB array of strings, kept in sync with `courtCount` by the host settings tab.
  Court occupancy is always computed live (which `ongoing` matches currently use which label), never cached, so
  renaming a court mid-session doesn't lose in-progress matches.
- Player identity is just a row ID stored in the participant's `localStorage` — there is no login. See
  "Known simplifications" below.

## Known simplifications vs. the original spec (intentional, flagged for follow-up)

- **No per-player identity check**: anyone with a participant's `localStorage` player ID (or who inspects
  network requests) could act as that player. The original spec flagged this as a stretch goal (PIN/device
  token). Fine for a casual club session; revisit before using this for anything with stakes.
- **No QR check-in**: joining is by URL (`/join/:sessionId`) rather than an in-app scanner. The host can share
  that URL directly; adding an actual QR code image would just be a client-side rendering of that same URL.
- **Court assignment is always a manual host action.** Earlier versions of this app auto-filled every open
  court the moment a match ended. That's intentionally gone: the host now always regenerates and/or picks a
  suggestion (or builds a custom match) explicitly, so they stay in control of exactly who plays when.
- **No predictive "up next" notification.** Since matches come from a pool of suggestions the host chooses
  between (not one fixed, ordered queue), there's no reliable position to count down from anymore. The
  participant-side notification (`ParticipantSession.tsx`) instead fires the moment the host actually sends
  someone to a court — accurate, but with less advance notice than the old "up soon" heads-up. In-session
  alerts remain an in-app toast + `navigator.vibrate`, which only fires while the tab is open, per the spec's
  original MVP carve-out. Real push (phone locked, app closed) would need a service worker + push provider.
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
  number is `matchmaking.ts`'s internal `LEVEL_SCORE`, which stays private to that module. `src/api.ts` also
  exports `LEVEL_ICON` / `LEVEL_LABEL` for the egg-to-chicken display icons — purely presentational, not used
  in any matchmaking logic.
- `getDb()` (in `db/index.ts`) deliberately does not pass a `schema` option to `drizzle()` — this app only uses
  the plain query builder (`db.select()/.insert()/.update()/.delete()`), never the `db.query.*` relational API,
  which is the only thing that option is for.
