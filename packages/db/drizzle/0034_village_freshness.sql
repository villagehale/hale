-- Village freshness: make cadence actionable and let "find fresh activities" REPLACE.
-- Additive only (rule #9): three nullable columns on village_candidates, no
-- destructive edits. RLS already enabled on this table (0012/0016).
--   1. event_date   — the calendar date of a one-time (or dated seasonal) event,
--      so the feed can drop events already in the past. NULL for ongoing options
--      and anything the source did not date (never fabricated).
--   2. seasons      — which seasons a seasonal activity runs (a set drawn from
--      'spring'|'summer'|'fall'|'winter'), so the feed can hide out-of-season
--      candidates. NULL for one-time/ongoing and unclassified rows.
--   3. superseded_at — stamped on a family's prior candidates when a newer
--      discovery run lands, so the old set is soft-retired (the live feed filters
--      superseded_at IS NULL) instead of hard-deleted — an endorsed or shared
--      candidate must survive for its public /a/:token page.
ALTER TABLE "village_candidates" ADD COLUMN "event_date" date;--> statement-breakpoint
ALTER TABLE "village_candidates" ADD COLUMN "seasons" text[];--> statement-breakpoint
ALTER TABLE "village_candidates" ADD COLUMN "superseded_at" timestamp with time zone;
