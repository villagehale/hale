-- Village timeframe search: let a family run a FRESH discovery scoped to a chosen
-- season alongside their standing weekly feed, without one clobbering the other.
-- Additive only (rule #9): two columns on village_candidates, no destructive edits.
-- RLS already enabled on this table (0012/0016).
--   1. run_type      — which run produced this row: 'standing' (the weekly feed) or
--      'search' (a parent-triggered season search). NOT NULL DEFAULT 'standing' so
--      every existing row backfills to the standing feed (correct by construction —
--      all rows to date are standing runs). Supersession is scoped by this column so
--      a search run never soft-retires the standing feed and vice-versa.
--   2. search_season — the season a 'search' run was scoped to
--      ('spring'|'summer'|'fall'|'winter'), so a read can pull the latest search for
--      that season. NULL for standing rows (and any pre-search row).
ALTER TABLE "village_candidates" ADD COLUMN "run_type" text NOT NULL DEFAULT 'standing';--> statement-breakpoint
ALTER TABLE "village_candidates" ADD COLUMN "search_season" text;
