CREATE TABLE "matches" (
	"id" serial PRIMARY KEY,
	"session_id" integer NOT NULL,
	"court_label" text NOT NULL,
	"team1" jsonb NOT NULL,
	"team2" jsonb NOT NULL,
	"status" text DEFAULT 'ongoing' NOT NULL,
	"score1" integer,
	"score2" integer,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" serial PRIMARY KEY,
	"session_id" integer NOT NULL,
	"name" text NOT NULL,
	"level" text DEFAULT 'C' NOT NULL,
	"requested_level" text,
	"status" text DEFAULT 'active' NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"points_for" integer DEFAULT 0 NOT NULL,
	"points_against" integer DEFAULT 0 NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"games_played" integer DEFAULT 0 NOT NULL,
	"last_match_ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"court_count" integer DEFAULT 4 NOT NULL,
	"court_labels" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id");--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id");