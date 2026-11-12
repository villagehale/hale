-- VIL-684. One city's registration opening for one cycle, as Hale last read it off that
-- city's official page: the per-city cache the per-family lookup reads. Family-agnostic
-- public reference data (a place name, a cycle label, what a public page said): no
-- family_id and no PII (rule #1). Append-only; the newest row per place and cycle wins.
-- Add-only (rule #9). Re-runnable. Reversible:
--   DROP TABLE IF EXISTS "city_registration_readings";
CREATE TABLE IF NOT EXISTS "city_registration_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_key" text NOT NULL,
	"city" text NOT NULL,
	"province_or_state" text,
	"country" text NOT NULL,
	"district" text,
	"cycle_label" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"municipality" text,
	"source_url" text,
	"reading" jsonb,
	"read_at" timestamp with time zone NOT NULL,
	"reverify_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "city_registration_readings_place_cycle_read_idx"
	ON "city_registration_readings" ("place_key", "cycle_label", "read_at");
--> statement-breakpoint
ALTER TABLE "city_registration_readings" ENABLE ROW LEVEL SECURITY;
