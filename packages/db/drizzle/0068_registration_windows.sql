-- VIL-236 (M1) — registration_windows: the registration radar's data moat. When each
-- GTA municipality opens registration for recreation programs, camps, swim lessons and
-- after-school care, so Hale can warn a family BEFORE the 6:30 a.m. scramble.
-- Additive only (rule #9).
--
-- Family-AGNOSTIC public reference data, same posture as curated_resources (0044):
-- no family_id, nothing here is PII (rule #1). Every row is hand-verified against the
-- municipality's own page, which is why source_url and verified_at are NOT NULL — a row
-- structurally cannot be a guess. A municipality that has not published its next date
-- gets NO row (an omission named in the coverage report), never a placeholder date.
--
-- municipality / program_domain are plain text, not enums: the covered set grows
-- town-by-town as each is verified, and adding one must not need a migration (an enum
-- ADD VALUE would). The TS unions in the Drizzle schema keep the app honest.
--
-- open_at (the general/non-resident open instant) is the one required date; preview_at,
-- resident_open_at, resident_priority_days and waitlist_response_hours are refinements
-- that are NULL where a municipality doesn't publish them. All instants are timestamptz
-- because registration opens at a WALL-CLOCK local time (6:30 a.m. America/Toronto) —
-- the seed encodes the local time with its explicit UTC offset so DST lands correctly.
--
-- (municipality, program_domain, cycle_label) is UNIQUE — the natural key, so the seed
-- sync is idempotent: a re-run updates a corrected date in place rather than
-- duplicating the cycle.
--
-- Slot note: file 0068 (next after 0067_mcp_interface); the journal is 1:1 with the
-- files, which is what the consistency gate checks.
CREATE TABLE "registration_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"municipality" text NOT NULL,
	"program_domain" text NOT NULL,
	"cycle_label" text NOT NULL,
	"preview_at" timestamp with time zone,
	"resident_open_at" timestamp with time zone,
	"open_at" timestamp with time zone NOT NULL,
	"resident_priority_days" integer,
	"waitlist_response_hours" integer,
	"age_min_months" integer,
	"age_max_months" integer,
	"source_url" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "registration_windows_municipality_domain_cycle_idx" ON "registration_windows" USING btree ("municipality","program_domain","cycle_label");--> statement-breakpoint
CREATE INDEX "registration_windows_municipality_open_idx" ON "registration_windows" USING btree ("municipality","open_at");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The
-- app connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "registration_windows" ENABLE ROW LEVEL SECURITY;
