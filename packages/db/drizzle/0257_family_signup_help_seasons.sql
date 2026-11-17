-- Per-family Browser Use signup attempts in one registration season
-- (`YYYY-winter` / spring / summer / fall in the family's timezone).
-- Additive (rule #9). New table only. Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS family_signup_help_seasons;

CREATE TABLE IF NOT EXISTS "family_signup_help_seasons" (
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"season_key" text NOT NULL,
	"attempted" integer NOT NULL DEFAULT 0,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "family_signup_help_seasons_family_id_season_key_pk" PRIMARY KEY ("family_id", "season_key"),
	CONSTRAINT "family_signup_help_seasons_attempted_nonneg" CHECK ("attempted" >= 0)
);--> statement-breakpoint
ALTER TABLE "family_signup_help_seasons" ENABLE ROW LEVEL SECURITY;
