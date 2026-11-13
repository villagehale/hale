-- VIL-685. One school board's winter break for one school year, as Hale last read it off
-- that board's own calendar page: the per-board cache the per-family lookup reads.
-- Family-agnostic public reference data (a board's host, a school year, what a public
-- page said): no family_id and no PII (rule #1). Append-only; the newest row per board
-- and school year wins. Add-only (rule #9). Re-runnable. Reversible:
--   DROP TABLE IF EXISTS "school_break_readings";
CREATE TABLE IF NOT EXISTS "school_break_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_host" text NOT NULL,
	"school_year" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"board_name" text,
	"source_url" text,
	"reading" jsonb,
	"read_at" timestamp with time zone NOT NULL,
	"reverify_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "school_break_readings_board_year_read_idx"
	ON "school_break_readings" ("board_host", "school_year", "read_at");
--> statement-breakpoint
ALTER TABLE "school_break_readings" ENABLE ROW LEVEL SECURITY;
