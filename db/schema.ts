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

export const sessions = pgTable("sessions", {
  id: serial().primaryKey(),
  name: text().notNull(),
  status: text("status").notNull().default("active"), // active | ended
  courtCount: integer("court_count").notNull().default(4),
  courtLabels: jsonb("court_labels").notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
});

// A permanent player login, separate from any one session. Created only through the
// host's QR-code registration flow (see appConfig.registrationToken below). A `players`
// row (one per session) can optionally link back to one of these via `accountId`, which
// is how a registered player's stats get added up across every session they've joined.
export const accounts = pgTable("accounts", {
  id: serial().primaryKey(),
  username: text().notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  name: text().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Single-row table holding app-wide settings. Today that's just the current player
// registration token (the value encoded in the host's sign-up QR code) -- regenerating
// it immediately invalidates any previously printed/displayed QR code.
export const appConfig = pgTable("app_config", {
  id: serial().primaryKey(),
  registrationToken: text("registration_token").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const players = pgTable("players", {
  id: serial().primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessions.id),
  name: text().notNull(),
  accountId: integer("account_id").references(() => accounts.id), // null for guest players
  level: text().notNull().default("C"), // A-E
  requestedLevel: text("requested_level"),
  status: text().notNull().default("active"), // active | resting | inactive
  approved: boolean().notNull().default(false),
  wins: integer().notNull().default(0),
  losses: integer().notNull().default(0),
  pointsFor: integer("points_for").notNull().default(0),
  pointsAgainst: integer("points_against").notNull().default(0),
  currentStreak: integer("current_streak").notNull().default(0),
  gamesPlayed: integer("games_played").notNull().default(0),
  lastMatchEndedAt: timestamp("last_match_ended_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const matches = pgTable("matches", {
  id: serial().primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessions.id),
  courtLabel: text("court_label").notNull(),
  team1: jsonb("team1").notNull(), // [playerId, playerId]
  team2: jsonb("team2").notNull(),
  status: text().notNull().default("ongoing"), // ongoing | completed
  score1: integer("score1"),
  score2: integer("score2"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
});
