# Player Accounts — What Changed & How to Apply It

This adds a registered-player account system (login, sign-up via host QR code, lifetime
stats, ranking, session history) on top of the existing guest/host flow, which is
untouched. Everything below is relative to your repo root — copy each file over the
matching path, overwriting what's there.

## Files changed (existing files, content replaced in full)

- `db/schema.ts` — adds `accounts` and `appConfig` tables, adds `accountId` to `players`
- `worker/lib/auth.ts` — adds player-account token functions alongside the existing host ones
- `worker/index.ts` — adds the new player-account/ranking/QR-token API routes
- `src/api.ts` — adds account types + API calls; `playerKey()` moved here (single source of truth)
- `src/App.tsx` — adds `/login`, `/signup`, `/player` routes
- `src/pages/Home.tsx` — redesigned: Login / Join as Guest, Host pinned to the corner
- `src/pages/HostSession.tsx` — Settings tab gets a new "Player registration QR code" card
- `src/pages/ParticipantJoin.tsx` — one-line change: imports `playerKey` from `api.ts` instead of defining it locally
- `src/pages/ParticipantSession.tsx` — falls back to an account lookup for "who am I" when the guest localStorage key isn't set
- `src/styles.css` — one rule added at the end (`.host-corner-btn`); nothing else touched
- `package.json` — adds the `qrcode` dependency
- `README.md` / `AGENTS.md` — documentation updated to match

## New files

- `worker/lib/password.ts` — password hashing (PBKDF2 via Web Crypto)
- `worker/lib/accountStats.ts` — overall stats / ranking / history calculations
- `src/pages/Login.tsx` — Log In form + Sign Up entry point
- `src/pages/Signup.tsx` — the account-creation form (only usable via the host's QR link)
- `src/pages/PlayerHome.tsx` — the logged-in player area (Home/Ranking/History/Account tabs)

## How to apply this

1. Copy all the files above into your repo at the same paths, overwriting the existing ones.
2. `npm install` — picks up the new `qrcode` dependency.
3. `npm run db:push` — creates the two new tables and the new column on `players`. This
   talks to whatever `DATABASE_URL` is in your `.env`, same as any other schema change.
4. `npm run dev` (or deploy as usual) and try it:
   - As host: Settings tab → "Generate code" to create your first registration QR code.
   - Scan it with your phone's camera app (not from inside Smashilog) → it opens the
     sign-up page in your phone's browser → create an account.
   - Log in from the home screen's "Login" button to see the new Player area.

No new secrets are needed — player-account tokens are signed with your existing
`HOST_PASSWORD` secret (see the comment at the top of `worker/lib/auth.ts` for why that's
fine security-wise).

## Decisions I made that you may want to double-check

- **Login is username + password only** (no email), per what you asked for. Usernames are
  stored lowercase and must be unique.
- **Joining a session as a registered player goes through the same host-approval step as
  a guest join request** — it shows up in the same "Pending join requests" list on the
  Players tab (now with a small "registered" tag), per what you asked for.
- **"Total points" / ranking points** = points the player's team scored (not point
  differential). **"Average score"** = total points ÷ games played.
- **Monthly ranking** groups sessions by the month they were created in (sessions are
  single-day events in this app, so there's no finer-grained date to split on).
- **The QR code is a link, not something scanned inside the app.** It encodes
  `yourapp.com/signup?token=...`; any phone's regular camera app opens it straight to the
  sign-up page. This avoids adding camera-permission/scanning code to the app itself.
- **No "Host" column in the active-sessions list** — this app only has one shared host
  password, not individual named hosts, so there was nothing to show there beyond the
  session name and player count.
- **Player tokens last 30 days** (vs. 12 hours for host tokens) so a registered player
  doesn't have to log back in every session.

If any of these don't match what you had in mind, they're all isolated enough to change
without touching the rest — happy to adjust once you've had a look.
