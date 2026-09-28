-- VIL-378 — GTA hidden-social watchlist.
-- Additive only (rule #9): one enum, two tables. Nothing existing is altered.
-- Re-runnable: CREATE TYPE is guarded, CREATE TABLE / INDEX use IF NOT EXISTS.
--
-- watched_sources is a curated list of professional accounts (Toronto, Peel,
-- York, Halton, Durham, plus a day-trip fringe). social_spots are activities
-- parsed from public captions or from a parent forward. Instagram Stories,
-- Xiaohongshu, and WeChat are not polled. A parent-forward spot carries
-- family_id so household erasure takes it (rule #1). Public poll spots leave
-- family_id null.
--
-- Both tables enable RLS with no policy, which denies the anon Data API.
-- The app connects as postgres (BYPASSRLS), the same posture as the other
-- reference tables added after the RLS ratchet.
DO $$ BEGIN
  CREATE TYPE "public"."gta_region" AS ENUM('toronto', 'peel', 'york', 'halton', 'durham', 'day_trip');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "watched_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"profile_url" text NOT NULL,
	"external_id" text,
	"account_type" text NOT NULL,
	"category" text NOT NULL,
	"region" "gta_region" NOT NULL,
	"geo_city" text,
	"geo_fsa" text,
	"lat" double precision,
	"lng" double precision,
	"civic_venue_id" uuid,
	"languages" text[] DEFAULT ARRAY['en']::text[] NOT NULL,
	"priority" integer DEFAULT 2 NOT NULL,
	"poll_cadence_minutes" integer DEFAULT 720 NOT NULL,
	"ingest_method" text NOT NULL,
	"tos_risk" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_media_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watched_sources_platform_chk" CHECK ("platform" IN ('instagram', 'facebook_page', 'xhs', 'web', 'parent_forward')),
	CONSTRAINT "watched_sources_account_type_chk" CHECK ("account_type" IN ('business', 'creator', 'page', 'unknown')),
	CONSTRAINT "watched_sources_category_chk" CHECK ("category" IN ('T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14')),
	CONSTRAINT "watched_sources_ingest_method_chk" CHECK ("ingest_method" IN ('graph_business_discovery', 'fb_ppca', 'parent_forward', 'manual', 'scrape_experiment')),
	CONSTRAINT "watched_sources_tos_risk_chk" CHECK ("tos_risk" IN ('official', 'gray', 'violates_tos'))
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "watched_sources" ADD CONSTRAINT "watched_sources_civic_venue_id_civic_venues_id_fk" FOREIGN KEY ("civic_venue_id") REFERENCES "public"."civic_venues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "watched_sources_platform_handle_uniq" ON "watched_sources" ("platform", "handle");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watched_sources_region_idx" ON "watched_sources" ("region");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watched_sources_category_idx" ON "watched_sources" ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watched_sources_due_idx" ON "watched_sources" ("last_polled_at") WHERE "active";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watched_sources_languages_gin" ON "watched_sources" USING gin ("languages");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "social_spots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"family_id" uuid,
	"platform_media_id" text NOT NULL,
	"permalink" text NOT NULL,
	"raw_caption" text,
	"media_kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"age_min" integer,
	"age_max" integer,
	"price_cents" integer,
	"capacity" integer,
	"registration_opens_at" timestamp with time zone,
	"registration_url" text,
	"venue_name" text,
	"venue_address" text,
	"category" text NOT NULL,
	"region" "gta_region" NOT NULL,
	"geo_fsa" text,
	"extraction_confidence" double precision NOT NULL,
	"extraction_method" text NOT NULL,
	"review_status" text NOT NULL,
	"watch_status" text,
	"next_wake_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_spots_media_kind_chk" CHECK ("media_kind" IN ('feed', 'reel', 'story_forward', 'screenshot')),
	CONSTRAINT "social_spots_category_chk" CHECK ("category" IN ('T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14')),
	CONSTRAINT "social_spots_extraction_method_chk" CHECK ("extraction_method" IN ('llm', 'human', 'placeholder')),
	CONSTRAINT "social_spots_review_status_chk" CHECK ("review_status" IN ('auto', 'needs_review', 'approved', 'rejected')),
	CONSTRAINT "social_spots_watch_status_chk" CHECK ("watch_status" IS NULL OR "watch_status" IN ('scheduled', 'armed', 'fired', 'filled', 'missed')),
	CONSTRAINT "social_spots_confidence_chk" CHECK ("extraction_confidence" >= 0 AND "extraction_confidence" <= 1),
	CONSTRAINT "social_spots_age_chk" CHECK ("age_min" IS NULL OR "age_max" IS NULL OR "age_min" <= "age_max")
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "social_spots" ADD CONSTRAINT "social_spots_source_id_watched_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."watched_sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "social_spots" ADD CONSTRAINT "social_spots_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "social_spots_source_media_uniq" ON "social_spots" ("source_id", "platform_media_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_spots_starts_at_idx" ON "social_spots" ("starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_spots_registration_opens_idx" ON "social_spots" ("registration_opens_at") WHERE "registration_opens_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_spots_wake_idx" ON "social_spots" ("next_wake_at") WHERE "watch_status" IN ('scheduled', 'armed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_spots_family_idx" ON "social_spots" ("family_id");--> statement-breakpoint

ALTER TABLE "watched_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "social_spots" ENABLE ROW LEVEL SECURITY;
