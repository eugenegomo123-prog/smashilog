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

export const players = pgTable("players", {
  id: serial().primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessions.id),
  name: text().notNull(),
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
  // Another player's id, same session. Self-service (a participant sets their own).
  // No DB foreign key, to keep a self-referencing column simple -- validated in the
  // API layer instead (must be an approved player in the same session).
  preferredPartnerId: integer("preferred_partner_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const matches = pgTable("matches", {
  id: serial().primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessions.id),
  courtLabel: text("court_label").notNull(),
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
