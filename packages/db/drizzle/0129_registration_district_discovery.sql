-- VIL-360. Two additive changes, one miss.
--
-- 1. Toronto opens a seasonal cycle on two mornings (Etobicoke / Toronto East
--    York, then North York / Scarborough). registration_windows had one
--    resident_open_at per (municipality, program_domain, cycle_label), so the
--    second morning could only live in notes. `district` is optional text:
--    NULL stays the city-wide row every existing seed already is. No row is
--    rewritten and none is deleted (rule #9).
--
--    The old unique index cannot hold two rows for one cycle, so it is replaced
--    by one that includes district. NULLS NOT DISTINCT keeps a single city-wide
--    row — without it Postgres would treat two NULLs as distinct and the seed
--    sync would insert a duplicate every run. Drizzle's uniqueIndex builder
--    cannot say NULLS NOT DISTINCT, so this statement is the source of truth
--    (same posture as memory_facts_one_live_per_key_idx).
--
-- 2. registration_discovery_readings stores each discovery-leg reading
--    (published, the reading, the page hash) instead of leaving it in an email.
--    A published target that is still open a week later is what the digest
--    escalates. Family-agnostic ops data: no family_id, no PII (rule #1).
ALTER TABLE "registration_windows" ADD COLUMN IF NOT EXISTS "district" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "registration_windows_municipality_domain_cycle_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registration_windows_municipality_domain_cycle_district_idx"
	ON "registration_windows" ("municipality", "program_domain", "cycle_label", "district")
	NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "registration_discovery_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"municipality" text NOT NULL,
	"program_domain" text NOT NULL,
	"cycle_label" text NOT NULL,
	"source_url" text NOT NULL,
	"published" boolean NOT NULL,
	"reading" jsonb,
	"page_hash" text,
	"read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registration_discovery_readings_target_read_idx"
	ON "registration_discovery_readings" ("municipality", "program_domain", "cycle_label", "read_at");
--> statement-breakpoint
ALTER TABLE "registration_discovery_readings" ENABLE ROW LEVEL SECURITY;
