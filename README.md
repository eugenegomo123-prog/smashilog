# Smashilog

Smashilog is a mobile-first web app for running a badminton doubles session courtside: it suggests balanced
2v2 matches from the players waiting, lets the host send them out to courts, and tracks live standings and
match history for the whole group.

## How it works

- **Host** creates a session (sets the number of courts), approves players who ask to join, regenerates a
  batch of suggested matchups at any time, sends a suggestion (or a custom match they build themselves) to
  whichever court is open, enters final scores as matches finish, and can delete a match from history if
  needed (stats are recalculated automatically).
- **Participants** join an active session by picking their name from the approved roster or submitting a
  join request, then track their own dashboard, the courts currently in play, the ranking table, and match
  history — all from their phone. They're notified the moment the host sends them out to a court.
- The matchmaking engine builds up to 8 suggested matchups from the players who are currently active and not
  already on a court, favoring whoever's played the fewest games (and waited longest), balancing each match's
  combined skill level, and trying to avoid repeating someone's last partner or sending them out twice in a
  row — best-effort, and automatically relaxed when the active player pool is too small to allow it. Nothing
  is sent to a court automatically: the host always picks which suggestion (or custom pairing) goes where.

## Tech stack

- **Frontend**: React + Vite, plain CSS, client-side routing with `react-router-dom`. The UI polls the API
  every few seconds so every device stays roughly in sync without a dedicated realtime backend.
- **Backend**: a single Cloudflare Worker (`worker/index.ts`), routed with [Hono](https://hono.dev) — one route
  per resource (sessions, players, matches, suggestion regeneration, match assignment, host login). All writes
  and the matchmaking logic run server-side; the client never decides who plays whom. The same Worker also
  serves the built frontend via Cloudflare's Static Assets, so the whole app is one deployment.
- **Data**: Postgres, via [Neon](https://neon.tech)'s HTTP driver (`@neondatabase/serverless` +
  `drizzle-orm/neon-http`) — this is the edge-friendly way to talk to Postgres from a Worker, since Workers
  don't support the raw TCP connections a normal `pg` client needs. Schema lives in `db/schema.ts`; migrations
  are generated with `drizzle-kit` into `db/migrations/`.
- **Host auth**: a single shared password (`HOST_PASSWORD` secret, defaults to `queuemaster` if unset) checked
  server-side in the Worker. On success the server issues a signed, time-limited token (HMAC'd with the same
  password, via the Web Crypto API) that the browser stores and replays for host-only actions — the password
  itself never lives in client code.

## Running locally

1. Copy `.dev.vars.example` to `.dev.vars` and fill in `DATABASE_URL` (a Postgres/Neon connection string) and
   optionally `HOST_PASSWORD`. This file is read by the Worker at dev time — never commit it.
2. Also create a plain `.env` with the same `DATABASE_URL` — this one is only for `drizzle-kit` (see below),
   which runs under plain Node rather than the Workers runtime.
3. Install and run:

   ```bash
   npm install
   npm run dev
   ```

`npm run dev` (via `@cloudflare/vite-plugin`) runs the React frontend and the Worker together in one process.
Visit the URL Vite prints (typically `http://localhost:5173`).

## Deploying to Cloudflare

```bash
npx wrangler login                      # one-time, opens a browser to authorize
npx wrangler secret put DATABASE_URL    # paste your Neon/Postgres connection string
npx wrangler secret put HOST_PASSWORD   # paste your host password
npm run deploy                          # builds, then `wrangler deploy`
```

Wrangler prints the `*.workers.dev` URL your app is live at. To push schema changes to the database, run
`npm run db:push` (reads `DATABASE_URL` from `.env`) any time `db/schema.ts` changes.

## Project structure

- `src/` — React frontend (pages for Home, Host login/sessions/session detail, Participant join/session detail)
- `worker/` — the Cloudflare Worker: `index.ts` is the Hono app with every route; `lib/` holds shared
  server-side logic (`matchmaking.ts`, `regenerate.ts`, `stats.ts`, `auth.ts`)
- `db/` — Drizzle schema (`schema.ts`) and the per-request client factory (`index.ts`)
- `db/migrations/` — generated SQL migrations (apply with `npm run db:push`, or hand them to your DB provider)
- `wrangler.jsonc` — Worker + static-assets configuration

## Known MVP simplifications

See `AGENTS.md` for details on what's scoped down for the first version (real push notifications, QR check-in,
per-player identity tokens) versus what's fully implemented.
