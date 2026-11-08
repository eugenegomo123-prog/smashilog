# AGENTS.md

Guidance for AI agents (and humans) working on this codebase. `README.md` covers first-time setup; this file covers
how the code is organised and the rules that are easy to break by accident. If you change behaviour described
here, update this file in the same change.

## Commands, deploys and the database

- `npm run dev` runs the frontend and the Worker together (needs `.dev.vars`; `.env` is only for drizzle-kit —
  see `README.md`).
- `npm run build` is `tsc -b` (frontend, `src/`) + `tsc -p worker/tsconfig.json` (Worker and `db/`) + `vite build`.
  Cloudflare runs exactly this, so a type error anywhere fails the deploy. `npm run typecheck:worker` runs only
  the Worker half.
- `npm run db:push` makes the database match `db/schema.ts` (`drizzle-kit push`, reads `DATABASE_URL` from `.env`).
  This is how every schema change has been applied; `db/migrations/` only holds the very first migration and is
  **not** the schema's history, so don't add to it by hand.
- **Deploys:** pushing to `main` deploys by itself (Cloudflare Workers Builds, GitHub check "Workers Builds:
  smashilog"). Pushing any other branch runs the same build as a check without touching the live site.
  `npm run deploy` exists but isn't normally needed. The secrets (`DATABASE_URL`, `HOST_PASSWORD`,
  `PLAYER_AUTH_SECRET`) live in Cloudflare, never in the repo.
- **Schema changes: order matters.** The Worker's queries select every column declared in `db/schema.ts`, so code
  that knows about a new column errors on a database that doesn't have it yet. Make new columns
  `notNull().default(...)` (old code simply ignores them), run `npm run db:push` first, then merge to `main`.
- `package-lock.json` must match `package.json`: Cloudflare installs from the lockfile, and a dependency added
  without updating it broke a deploy once (commit `8122bf4` removed vitest for that reason).

## Architecture

- **Frontend** (`src/`): React 18 + Vite SPA, routed with `react-router-dom` (routes in `src/App.tsx`). No global
  state library — each page fetches what it needs through `src/api.ts` and polls: the host session page every 5 s,
  the participant session page every 4 s. There is no websocket/realtime layer; if real realtime becomes a
  requirement, replace that polling in `HostSession.tsx` / `ParticipantSession.tsx`.
- **Backend** (`worker/index.ts`): one Cloudflare Worker routed with Hono. Every `/api/*` route lives in that one
  file; anything else goes to the static-assets binding (single-page-app fallback, see `wrangler.jsonc`). All
  matchmaking, queueing and stat calculation happens server-side — the client sends scores, names, status/level
  changes and match-building requests, and shows what the server returns. Bindings arrive per request via `c.env`
  (`DATABASE_URL`, `HOST_PASSWORD`, `PLAYER_AUTH_SECRET`, `ASSETS`); there is no `process.env` in Workers, so
  nothing may read them at module load. Every handler that needs the database calls `getDb(c.env.DATABASE_URL)`.
  An uncaught error returns `{ error: <message> }` with status 500 (`app.onError`), and the client shows that
  message.
- **Data** (`db/`): Drizzle schema for Postgres (Neon) through `drizzle-orm/neon-http`. `db/schema.ts` is the single
  source of truth — never hand-write `CREATE TABLE` SQL.
  - **Every query is its own HTTP request** to Neon: there are **no transactions** and no locking, and a Worker
    request is only allowed a limited number of such subrequests (about 50 on the Workers Free plan). So keep the
    number of queries per request low (`recomputeSessionStats` skips unchanged players for this reason; the
    assign / custom-match routes with Auto queue on made about 10–16 calls in simulation), and write code that stays
    correct if two requests interleave (e.g. `runAutoQueue` re-counts the queue right before inserting).
- **Pure modules shared with the browser:** `worker/lib/matchmaking.ts` and `worker/lib/autoqueue.ts` have no I/O
  and import nothing but each other, and `src/pages/HostSession.tsx` imports them directly so the screen shows
  exactly what the server will do (match quality grades, "small group" hint, "this replaces N planned matches").
  Keep both free of database, Worker-only and Node-only code.

## Host, guests and accounts

- **Host:** one shared password. `POST /api/host-auth` swaps it for a signed token (HMAC over an expiry, 12 h,
  `worker/lib/auth.ts`) that the browser keeps in `localStorage` (`smashilog_host_token`) and sends as
  `x-host-token`. Host-only routes call `requireHost`. `HOST_PASSWORD` falls back to `queuemaster` if unset, so set
  it in production. Changing it signs every host out.
- **Accounts:** registered players have a username + password (PBKDF2, `passwords.ts`) and a 30-day token
  (`playerAuth.ts`) kept in `localStorage` (`smashilog_player_token`) and sent as `x-player-token`. It is signed
  with `PLAYER_AUTH_SECRET`, deliberately a different secret from the host's, so the two token kinds can't be
  swapped. **Without `PLAYER_AUTH_SECRET` the register, login and registration-QR routes refuse to run.**
  Registering needs a short-lived registration token that the host's Settings tab shows as a QR code
  (`POST /api/host/registration-token`).
- **Session players are rows in `players`.** A *guest* has `accountId` null; their player id is kept in
  `localStorage` (`smashilog_player_<sessionId>`). A registered player has `accountId` set and is found again with
  `GET /api/sessions/:id/my-player`. **Every feature must keep working for guests.** Guests have no rating, photo
  or cross-session history.
- A new player always starts `status: "inactive"` (joining isn't the same as having arrived), and `approved: false`
  unless the host added them. The host approves join requests and sets `level` (what the player asked for is kept
  in `requestedLevel`); `approved`, `name` and `level` are host-only. Status (`active` / `resting` / `inactive`),
  `playingMode` (`competitive` / `chill` — chill players are left out of rankings) and `preferredPartnerId` are
  self-service and **not authenticated** (see Known simplifications). Only approved + active players are ever put
  in a match.

## The match queue model

Matches live in one `matches` table; `status` is plain text (not a DB enum), with four values:

1. **`suggested`** — an idea from `regenerateQueue` (the host's Regenerate button). No court, never started on its
   own; several suggestions can share players. Regenerating replaces the whole batch, and any suggestion that
   shares a player with a match that was just queued is deleted as stale.
2. **`queued`** — waiting in the single queue: at most 8 (`MAX_QUEUE_LENGTH` in `worker/lib/queue.ts`; the host
   screen also writes the 8 in `HostSession.tsx`, so change both), ordered by `queuePosition` (0 = front).
   Positions can have gaps — only their order matters. A match gets here when the host moves a suggestion in
   (`POST /sessions/:id/assign-match`), builds one by hand (`.../custom-match`), or the Auto queue plans it
   (`matches.auto = true`).
3. **`ongoing`** — on a court (`courtId` + the `courtLabel` it had at that moment).
4. **`completed`** — has `score1` / `score2` and `endedAt`; feeds `recomputeSessionStats` and the History tabs.

**The host never picks a court.** Courts pull from the front of the queue: `fillOpenCourtsFromQueue` (in
`queue.ts`) puts the first queued matches whose players are all approved + active and not on another court onto the
open courts. A queued match that can't start yet is skipped and stays in place rather than blocking the rest. It
runs after every change that can free a court or change the queue — assign-match, custom-match, queue reorder, a
match finishing, an on-court match being deleted.

Finishing a match is `PATCH /api/matches/:id`: it saves the score, calls `recomputeSessionStats`, and on the
**first** completion fills the freed court (`fillOpenCourtsFromQueue(..., { replan: true })`) and then updates
ratings. Editing a score later re-runs the stats only. `DELETE /api/matches/:id` rolls the rating change back (when
safe), deletes the match, recomputes stats and, if it was on a court, fills it again. Suggestions can't be deleted
that way.

With Auto queue **off**, anyone in an `ongoing` or `queued` match is unavailable for new suggestions
(`playerIdsUnavailable` in `stats.ts`) and for assign-match / custom-match (`blockedForManualMatch`).

## Auto queue

The host's switch on the Queue tab (`sessions.autoQueue`, default off — a session is a plain manual queue until it
is switched on). While on, the server plans the next matches by itself, keeps the queue topped up, and plans
**ahead**: a queued match may include players who are still on court, as long as they should be free by the time it
would start. Planned matches carry `matches.auto = true` and an "Auto" tag in the queue list.

- **The planner** is `worker/lib/autoqueue.ts`, pure and covered by `autoqueue.test.ts`. Priority order, the same
  as the rest of the app: (1) **nearest level** — it reuses `matchmaking.ts` (`bestSplit`, `compareMetrics`,
  `matchQuality`) and never re-implements it, and a match graded Uneven/Poor is avoided when someone else in line can
  make a better one (unless the player at the front of the line has already been passed over for two rounds, so a
  lone outlier still gets to play); (2) **balanced teams**; (3) **fair games and rest** — fewest games first
  (finished + on court + already queued), nobody plays more than `MAX_IN_A_ROW` (2) games in a row when enough
  rested players exist; (4) **shuffle** partners and opponents. A lower-priority rule must never force a badly
  unbalanced match.
- **Two modes** (`lookaheadModeFor`): *full* look-ahead needs `4 × courts + 4` active players
  (`playersNeededForLookahead`); with fewer it switches to *small* mode — only players free right now are used and
  the rest rule bends rather than leaving a court empty. The host screen shows a hint in that case. The queue is
  planned about two rounds ahead (`queueTargetLength`, at most 8).
- **The database side** is `worker/lib/queue.ts`: `syncAutoQueue` / `syncAutoQueueQuietly` load the rows once, put
  matches on open courts, drop planned matches that stopped making sense (someone resting or gone, a third game in
  a row), plan new ones, and fill courts again. It is triggered by: switching Auto on, changing the court count,
  reopening an ended session, a player's status or approval changing, a player being removed, and — through
  `fillOpenCourtsFromQueue(..., { replan: true })` — a match being queued by hand, finishing or being deleted.
  `POST /sessions/:id/auto-queue/rebuild` (the Rebuild button) throws the waiting planned matches away and plans
  them again.
- **Errors in Auto queue never undo the change that triggered them.** The triggers above call the `…Quietly`
  variants (or a try/catch) because the score, status or court change is already saved. Only Rebuild reports
  errors to the host.
- **Hand-built matches beat planned ones.** The planner only ever drops or replaces `auto` matches; matches the host
  made are never touched. With Auto on, a match the host builds or picks goes **right after the last hand-made
  match** (ahead of the planned ones) and replaces planned matches that share a player with it — plus the last
  planned ones if the queue would pass 8. Planned matches neither hold players nor count towards the 8; hand-made
  matches and players on court still do. Pure rules: `planManualInsert`, `blockedForManualMatch`,
  `isManualQueueFull`; applied by `makeRoomForManualMatch` / `manualMatchLimits` in `queue.ts`; the Queue tab calls
  `planManualInsert` to say how many planned matches a new match will replace. With Auto off none of this applies.
  Switching Auto off leaves its planned matches in the queue as ordinary ones.
- **Suggestions are unchanged:** `regenerateQueue` still skips anyone in any ongoing or queued match, planned or
  not. The custom match builder is the way to override the plan.
- **The look-ahead is a forecast.** It assumes matches finish in the order they started. Courts therefore always
  take whichever queued match is actually ready (`selectMatchesToStart`), and the plan is re-checked whenever a match
  finishes. The player Home and the Live tab show it (`src/ui/live.ts` `myQueuedMatch` / `matchesStillBlocking`,
  `src/ui/NextUp.tsx`).
- `players.gamesBaseline` (a head start for late arrivals) is read by the planner but **nothing ever sets it** — it
  is always 0. Simulated sessions showed that counting latecomers from zero already keeps them level with
  everyone, while a group-average baseline under-served them. Don't wire it up without re-running that check.

## Server modules (`worker/lib/`)

- `matchmaking.ts` — pure. Every candidate 4-player match is reduced to a `MatchMetrics` tuple and compared
  tier by tier (`compareMetrics`): skill spread, total skill distance, team strength gap, partner gap within a team,
  games played, wait time, consecutive games, repeat partner, repeat opponent, repeated 4-player group, then a
  deterministic tiebreak. Strictly tiered on purpose — a later tier can never outweigh a skill mismatch.
  `generateSuggestedMatches` builds up to 8 suggestions (a jointly optimised round, then a fairness pass that
  rescues a lone skill outlier); `matchQuality` gives the Excellent/Good/Fair/Uneven/Poor grade the host sees;
  `completeBalancedMatch` powers the "Balance match" button. Best-effort: with a tiny pool, repeats are
  unavoidable and it relaxes instead of erroring.
- `regenerate.ts` — `regenerateQueue` (pool = approved + active players not on court or in the queue; replaces the
  session's `suggested` rows) and `buildPairHistory` (partner / opponent history from completed matches). Only the
  Regenerate button calls it.
- `autoqueue.ts`, `queue.ts` — see Auto queue above.
- `stats.ts` — `recomputeSessionStats` rebuilds every player's wins, losses, points, streak, games played and last
  match time from the **full** completed-match history instead of patching deltas, which is what makes editing a
  score or deleting a match correct with no extra bookkeeping. Read the comment before making it incremental.
- `courts.ts` — a session's courts are `{ id, label }` objects (`sessions.courtLabels`, JSONB). The `id` is stable,
  so renaming a court mid-match (`PATCH /sessions/:id/courts/:courtId`) never orphans the match on it; occupancy is
  always computed live from the `ongoing` matches (`isCourtOccupied`, by `courtId`), never cached.
  `normalizeCourts` also upgrades old plain-string rows; every route returns sessions through `presentSession`.
- `auth.ts`, `playerAuth.ts`, `passwords.ts` — tokens and password hashing (Web Crypto, so every function is async).
- `rating.ts` / `ratingIntegration.ts` — the rating engine (pure) and its database glue.
- `accountStats.ts` — cross-session numbers for an account: overall stats, partner and head-to-head stats, all-time
  and monthly ranking, session history and per-session detail.

## Ratings and ranks

Registered accounts have a hidden Elo/Glicko-style rating (`accounts.mmr` + `ratingDeviation`) plus season points.
The client only ever sees the derived **tier** — Fledgling, Rally, Smash, Ace, Champion, Legend, with divisions I–III
on the middle four — never the raw number (`publicRatingView`). A tier is "provisional" until
`PROVISIONAL_GAMES_THRESHOLD` rated games or while the rating is uncertain. Rank is capped by the host-approved
session level so nobody can sandbag a low level to climb (`LEVEL_MMR_CAP`, with a catch-up bonus from
`LEVEL_MMR_TARGET`). Guests are never rated; they count as opponents and partners at a level-based rating
(`GUEST_LEVEL_MMR`).

- `rateCompletedMatch` runs once, when a match **first** completes. A later score edit never re-rates, so a
  correction can't double-apply. It is wrapped in try/catch at the call site: a rating bug must never stop a host
  recording a score.
- `rollbackMatchRating` runs when a match is deleted. It is skipped when the account has since played a newer rated
  match (undoing it safely would need a full replay), and the `rating_history` rows are cleared either way —
  they reference the match, so the delete would fail on the foreign key otherwise (account deletion clears them
  too).
- The tier thresholds are mirrored in `src/api.ts` (`TIER_ORDER`, `rankScore`, `TIER_BADGE_IMAGE`) — keep the two in
  step. `rating.ts` mentions a design document, `docs/rating-system-design.md`, that is not in the repo.

## Data model notes

- `matches.team1` / `team2` are JSONB arrays of two player ids (no join table — never more than 2 per team). This
  holds for `suggested` and `queued` rows too.
- `matches.courtLabel` is `""` (not null) until a match goes on a court; `matches.courtId` is null until then.
  `courtLabel` is a frozen snapshot for History — show a live court's name through `liveCourtLabel` in `src/api.ts`.
- Per-session stats (`wins`, `losses`, `pointsFor`, `pointsAgainst`, `currentStreak`, `gamesPlayed`,
  `lastMatchEndedAt`) are stored on `players` but only ever written by `recomputeSessionStats`.
- A profile picture is a `data:` URL on the **account**, set once in the Account tab (`src/imageUpload.ts` shrinks
  it first). It is deliberately left out of the bulk roster list that every device polls; `<img>` tags use
  `GET /api/players/:id/picture` or `/api/accounts/:id/picture` with `pictureUpdatedAt` as a cache-buster
  (`playerPictureUrl` / `accountPictureUrl` in `src/api.ts`).
- Usernames can change once every 30 days (`accounts.usernameChangedAt`).

## Frontend map

- `src/pages/` — `Home`, `HostLogin`, `HostSessions`, `HostSession` (tabs Players, Courts/Live, Queue, Ranking,
  History, Settings), `ParticipantSessions`, `ParticipantJoin`, `ParticipantSession` (tabs Home, Queue, Ranking,
  History, Me), `Login`, `Register` (needs the QR token), `PlayerHome` (the account area at `/me`: Stats, Rank,
  Ranking, History, Account), `PlayerProfile`, `PartnerStatsPage`. The two session pages are large single files with
  their tab components inside; some tab code (Ranking, History) exists as near-identical copies in both, so check
  the other file when you change one.
- `src/ui/` — shared pieces: `Icon` (the one inline-SVG icon set — no icon package), `BottomNav`, `SessionHeader`,
  `StatTiles` + `CountUp`, `CourtParts`, `NextUp`, `QueueParts`, `RankRows`, `HistoryParts`, `SessionRow`,
  `Skeleton`, and `live.ts` (pure helpers such as `eligiblePoolFor`, `courtSlots`, `myQueuedMatch`).
- Top level of `src/` — `api.ts` (typed client and shared types; adds the auth headers and throws
  `Error(server message)`), `dialogs.tsx`, `loading.tsx`, `shareImage.ts` (draws the shareable results PNG on a
  canvas), `overallRecord.tsx`, `partnerStats.tsx`, `accountAvatar.tsx`, `rankAvatar.tsx`, `imageUpload.ts`.
- **Dialogs:** use `alertDialog` / `confirmDialog` / `promptDialog` from `src/dialogs.tsx` (awaited, themed,
  rendered by `DialogHost` in `App.tsx`) — never the browser's `alert` / `confirm` / `prompt`.
- **Loading:** `Loading` and the `Skeleton` screens, which keep the real cards' sizes so nothing jumps.
- **Styling:** one stylesheet, `src/styles.css`, driven by CSS variables in `:root` (dark navy with a bright green
  accent; `--accent`, `--bg`, `--panel`, `--muted`, `--bad` …). Phone first: `.screen` is at most 560 px wide, with
  tablet and desktop rules from 768 px up, touch targets of 44–48 px, and `prefers-reduced-motion` honoured. Level
  mascots are the egg-to-chicken emoji (`LEVEL_ICON`: E egg, D hatchling, C chick, B chicken, A roast); controls,
  tabs and arrows use `Icon`, not emoji. The join and registration QR images come from the
  third-party `api.qrserver.com` (the URL being encoded is sent to it).

## Testing and checking your work

- There is **no test runner installed** (no `npm test`). `worker/lib/rating.test.ts`, `matchmaking.test.ts` and
  `autoqueue.test.ts` are written against vitest-style `describe` / `it` / `expect` and are excluded from the
  Worker type-check. They call the pure functions with fixed inputs and clocks, so they run as-is once a runner is
  added — or, where installing isn't possible, with a tiny stand-in that provides those three functions. If you add
  vitest, update `package-lock.json` too (see above).
- Before pushing, run `npm run build`, or at least `tsc -b` and `npm run typecheck:worker`. The Cloudflare build on
  a pushed branch is the same check.
- Anything that changes who plays whom (`autoqueue.ts`, `queue.ts`, the assign / custom / reorder routes) deserves
  a simulation over many random sessions, not just a few hand-picked ones — most of that code's bugs were
  interactions, not single cases.

## Known simplifications (intentional)

- **No per-guest identity check.** Anyone who knows a guest's player id can act as them, and `PATCH /api/players/:id`
  lets anyone change a player's status, mode or preferred partner without a token. Fine for a casual club session;
  revisit before using this for anything with stakes.
- **No in-app QR scanner.** Joining a session is by URL (`/join/:id`) and registering is by a QR code the host shows;
  players scan them with the phone's camera.
- **Alerts are in-app only:** a popup plus `navigator.vibrate` while the page is open. Real push (phone locked, app
  closed) would need a service worker and a push provider.
- **No realtime sync:** devices poll every 4–5 seconds, which is plenty for courtside use. Swap in Postgres
  LISTEN/NOTIFY or a realtime provider if that changes.
- **Ratings are applied once** (see above); editing a score afterwards fixes the session stats but not the rating.
- **The Auto queue's look-ahead is a best-effort forecast** (see above), not a promise about who plays when.

## Conventions

- Worker code imports from `db/` and between `worker/lib/` modules with plain extensionless relative paths
  (`../../db`, `./matchmaking`) — esbuild bundles it, so no `.js` extension is needed.
- Column names in `db/schema.ts` are snake_case strings and TS fields are camelCase; follow that for new columns.
- Levels are the letters `A`–`E` (A best) everywhere in the UI and API. Only `matchmaking.ts` maps them to numbers
  (`LEVEL_SCORE`, private); `autoqueue.ts` has its own small level index for the same purpose.
- `getDb()` (in `db/index.ts`) deliberately passes no `schema` option to `drizzle()`: the app only uses the plain
  query builder (`db.select()` / `.insert()` / `.update()` / `.delete()`), never `db.query.*`.
- When a route's response changes shape, update the matching type in `src/api.ts`.
- Don't change existing behaviour as a side effect of a new feature, and keep guest flows working. New features
  that touch the queue should leave a session with Auto queue **off** behaving exactly as before.
