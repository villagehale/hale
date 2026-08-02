-- VIL-252 · M16 free civic programming layer — the venue registry and its sessions.
-- Additive only (rule #9): two new tables, nothing dropped, no existing column changes
-- meaning. Both are family-AGNOSTIC public reference data (no family_id, no PII) in the
-- same class as registration_windows and curated_resources.
--
-- Plain `text` + a TS union for `system`, `kind`, `recurrence` and `extraction` rather
-- than pg enums, deliberately: coverage grows one library system at a time, and adding
-- Vaughan or Mississauga must be a data change, not an ALTER TYPE migration.
--
-- THE CHECK CONSTRAINTS ARE THE POINT. A session states its time in exactly one of two
-- shapes — a dated instant, or a weekly wall-clock slot — and the constraint makes the
-- other shape's columns NULL by force. A row claiming to be a weekly drop-in while
-- carrying a single timestamp cannot be inserted, so no reader has to defend against
-- one. Wrong-time is the failure that actually hurts a parent (showing up Wednesday for
-- a Thursday storytime with a toddler in tow), so it is excluded at the storage layer
-- rather than checked in application code that a future caller could bypass.
CREATE TABLE IF NOT EXISTS "civic_venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"postal_code" text,
	"lat" double precision,
	"lng" double precision,
	"url" text,
	"source_url" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "civic_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"recurrence" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"day_of_week" integer,
	"start_minute" integer,
	"end_minute" integer,
	"age_min_months" integer,
	"age_max_months" integer,
	"is_free" boolean DEFAULT true NOT NULL,
	"registration_required" boolean DEFAULT false NOT NULL,
	"is_cancelled" boolean DEFAULT false NOT NULL,
	"extraction" text NOT NULL,
	"confidence" double precision NOT NULL,
	"source_url" text NOT NULL,
	"parsed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Exactly one time shape, enforced in both directions.
	CONSTRAINT "civic_sessions_time_shape_check" CHECK (
		("recurrence" = 'occurrence'
			AND "starts_at" IS NOT NULL AND "ends_at" IS NOT NULL
			AND "day_of_week" IS NULL AND "start_minute" IS NULL AND "end_minute" IS NULL)
		OR
		("recurrence" = 'weekly'
			AND "starts_at" IS NULL AND "ends_at" IS NULL
			AND "day_of_week" IS NOT NULL AND "start_minute" IS NOT NULL AND "end_minute" IS NOT NULL)
	),
	-- A session that ends before it starts is a parse failure, not a short session.
	CONSTRAINT "civic_sessions_occurrence_order_check" CHECK (
		"starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at"
	),
	-- Weekly slots live in one wall-clock day: 0=Sunday..6=Saturday, and the minute
	-- bounds keep an "11:30 p.m. - 1:00 a.m." misparse out of the table entirely.
	CONSTRAINT "civic_sessions_weekly_bounds_check" CHECK (
		"day_of_week" IS NULL OR (
			"day_of_week" BETWEEN 0 AND 6
			AND "start_minute" BETWEEN 0 AND 1439
			AND "end_minute" BETWEEN 1 AND 1440
			AND "end_minute" > "start_minute"
		)
	),
	CONSTRAINT "civic_sessions_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1),
	-- An age band that runs backwards means the parse mixed up two numbers.
	CONSTRAINT "civic_sessions_age_order_check" CHECK (
		"age_min_months" IS NULL OR "age_max_months" IS NULL
		OR "age_max_months" >= "age_min_months"
	)
);
--> statement-breakpoint
ALTER TABLE "civic_sessions" ADD CONSTRAINT "civic_sessions_venue_id_civic_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."civic_venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "civic_venues_system_external_uniq" ON "civic_venues" ("system","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "civic_venues_city_idx" ON "civic_venues" ("city");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "civic_sessions_venue_external_uniq" ON "civic_sessions" ("venue_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "civic_sessions_venue_idx" ON "civic_sessions" ("venue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "civic_sessions_starts_at_idx" ON "civic_sessions" ("starts_at");
