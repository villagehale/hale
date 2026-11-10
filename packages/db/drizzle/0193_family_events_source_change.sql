-- VIL-474 · the last change a provider made to an event, recorded from source data
-- only: a provider's email (reschedule notice or re-sent receipt) named a different start
-- or venue than Hale had stored. The calendar mirror records nothing here.
-- Add-only: four nullable columns, no default, no backfill, no row rewrite.
-- Reversible:
--   ALTER TABLE "family_events" DROP COLUMN "source_changed_field";
--   ALTER TABLE "family_events" DROP COLUMN "source_changed_from_starts_at";
--   ALTER TABLE "family_events" DROP COLUMN "source_changed_from_location";
--   ALTER TABLE "family_events" DROP COLUMN "source_changed_at";
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "source_changed_field" text;--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "source_changed_from_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "source_changed_from_location" text;--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "source_changed_at" timestamp with time zone;
