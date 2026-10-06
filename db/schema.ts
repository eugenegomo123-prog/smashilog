import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  real,
  serial,
} from "drizzle-orm/pg-core";

// A registered player's persistent login. Separate from the single shared host
// password -- this is per-player, so each person has their own username/password.
export const accounts = pgTable("accounts", {
  id: serial().primaryKey(),
  username: text().notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  // --- Rating engine (worker/lib/rating.ts) -- all additive, all default to a
  // fresh/unrated starting state so existing accounts need no backfill beyond
  // these defaults. Never written to directly outside worker/lib/ratingIntegration.ts.
  // `mmr`/`ratingDeviation` are the hidden Elo/Glicko-style numbers; the app only
  // ever shows the derived tier (see mmrToTier) and seasonPoints, never these raw
  // values.
  mmr: real().notNull().default(1000), // rating.ts's BASE_MMR
  ratingDeviation: real("rating_deviation").notNull().default(350), // rating.ts's RD_START
  ratedGamesPlayed: integer("rated_games_played").notNull().default(0),
  seasonPoints: integer("season_points").notNull().default(0),
  // Consecutive rated wins across all sessions -- separate from a session's own
  // per-session currentStreak (players.currentStreak), since this one needs to
  // persist across sessions for the Season Points streak bonus.
  currentRatingStreak: integer("current_rating_streak").notNull().default(0),
  // Null until this account's first rated match; used to grow ratingDeviation
  // (lower confidence) the longer an account goes without a rated match.
  lastRatedMatchAt: timestamp("last_rated_match_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  id: serial().primaryKey(),
  name: text().notNull(),
  status: text("status").notNull().default("active"), // active | ended
  courtCount: integer("court_count").notNull().default(4),
  // Array of { id: string, label: string } -- id is a stable, server-generated
  // identity for the physical court, independent of its display label, so
  // renaming a court (worker/index.ts's PATCH /sessions/:id/courts/:courtId)
  // never breaks the link to a match already in progress on it. (Older rows
  // predating this may still hold plain strings; see src/api.ts for the
  // reading-both-shapes note -- but every write path emits objects only.)
  courtLabels: jsonb("court_labels").notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
});

export const players = pgTable("players", {
  id: serial().primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessions.id),
  name: text().notNull(),
  level: text().notNull().default("C"), // A-E
  requestedLevel: text("requested_level"),
  // Starts "inactive" -- a newly-joined/added player isn't pulled into
  // matchmaking suggestions until the host flips them to "active" (see
  // POST /sessions/:id/players in worker/index.ts), since joining doesn't
  // mean they've actually checked in at the venue yet.
  status: text().notNull().default("inactive"), // active | resting | inactive
  playingMode: text("playing_mode").notNull().default("competitive"), // competitive | chill (chill = excluded from ranking)
  approved: boolean().notNull().default(false),
  wins: integer().notNull().default(0),
  losses: integer().notNull().default(0),
  pointsFor: integer("points_for").notNull().default(0),
  pointsAgainst: integer("points_against").notNull().default(0),
  currentStreak: integer("current_streak").notNull().default(0),
  gamesPlayed: integer("games_played").notNull().default(0),
  lastMatchEndedAt: timestamp("last_match_ended_at"),
  // Another player's id, same session. Self-service (a participant sets their own).
  // No DB foreign key, to keep a self-referencing column simple -- validated in the
  // API layer instead (must be an approved player in the same session).
  preferredPartnerId: integer("preferred_partner_id"),
  // Set when this player row belongs to a registered account rather than a guest.
  // Guests (today's flow) leave this null, unchanged.
  accountId: integer("account_id").references(() => accounts.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const matches = pgTable("matches", {
  id: serial().primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessions.id),
  // Display-name snapshot: whatever the court was called at the moment this
  // match became ongoing (or "" if it never has been -- suggested/queued).
  // Frozen from then on, which is exactly right for history ("what was this
  // called when it was played"), but NOT what live occupancy should match
  // against -- see courtId below.
  courtLabel: text("court_label").notNull(),
  // Stable court identity (worker/lib/courts.ts's Court.id), independent of
  // the label above, so renaming a court mid-match (PATCH
  // /sessions/:id/courts/:courtId) can't orphan an in-progress match from the
  // physical court it's actually on. Null while suggested/queued (no court
  // yet) and for any match that was already ongoing before this column
  // existed -- worker/lib/courts.ts's isCourtOccupied() falls back to
  // matching courtLabel for that one-time transitional case.
  courtId: text("court_id"),
  team1: jsonb("team1").notNull(), // [playerId, playerId]
  team2: jsonb("team2").notNull(),
  status: text().notNull().default("ongoing"), // ongoing | queued | completed | suggested
  score1: integer("score1"),
  score2: integer("score2"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
  // Only meaningful while status is "queued" -- position in the actual queue (0 = front).
  queuePosition: integer("queue_position"),
});

// One row per account per rated match -- an audit trail for the rating engine
// (worker/lib/rating.ts via worker/lib/ratingIntegration.ts), and the raw data
// a future "rating over time" chart would read. Purely additive: nothing reads
// this table today except (eventually) such a chart; the live app's behavior
// doesn't depend on it existing.
export const ratingHistory = pgTable("rating_history", {
  id: serial().primaryKey(),
  accountId: integer("account_id").notNull().references(() => accounts.id),
  matchId: integer("match_id").notNull().references(() => matches.id),
  previousMmr: real("previous_mmr").notNull(),
  newMmr: real("new_mmr").notNull(),
  mmrChange: real("mmr_change").notNull(),
  previousRatingDeviation: real("previous_rating_deviation").notNull(),
  newRatingDeviation: real("new_rating_deviation").notNull(),
  previousSeasonPoints: integer("previous_season_points").notNull(),
  newSeasonPoints: integer("new_season_points").notNull(),
  seasonPointsChange: integer("season_points_change").notNull(),
  won: boolean().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
