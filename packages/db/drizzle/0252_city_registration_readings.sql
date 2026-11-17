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
--> statement-breakpoint
-- VIL-684. Each municipality's own official website, as a structured public source names
-- it (Wikidata's "official website", P856), so a registration page is read only when its
-- host is that site or under it. Family-agnostic public reference data, like the table
-- above: no family_id and no PII. Append-only; the newest row per municipality wins.
-- Reversible:
--   DROP TABLE IF EXISTS "city_official_sites";
CREATE TABLE IF NOT EXISTS "city_official_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"municipality_key" text NOT NULL,
	"city" text NOT NULL,
	"province_or_state" text,
	"country" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"host" text,
	"website" text,
	"source" text,
	"checked_at" timestamp with time zone NOT NULL,
	"recheck_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "city_official_sites_key_checked_idx"
	ON "city_official_sites" ("municipality_key", "checked_at");
--> statement-breakpoint
-- Whether the source's statement of the website carries a reference: one of the two
-- signals that may corroborate it. Null on a not_found row. Added in place so a database
-- that already has the table gains it on a re-run.
ALTER TABLE "city_official_sites" ADD COLUMN IF NOT EXISTS "referenced" boolean;
--> statement-breakpoint
ALTER TABLE "city_official_sites" ENABLE ROW LEVEL SECURITY;
