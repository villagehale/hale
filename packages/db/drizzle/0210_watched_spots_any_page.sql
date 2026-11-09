-- VIL-337 · watching a program page outside the PerfectMind registry: the page text that
-- named the session at arming, and the digest of the last quiet page text.
-- Additive (rule #9). Two nullable columns. Re-runnable: IF NOT EXISTS. Reversible:
--   ALTER TABLE watched_spots DROP COLUMN IF EXISTS session_anchor;
--   ALTER TABLE watched_spots DROP COLUMN IF EXISTS page_digest;

ALTER TABLE "watched_spots" ADD COLUMN IF NOT EXISTS "session_anchor" text;
ALTER TABLE "watched_spots" ADD COLUMN IF NOT EXISTS "page_digest" text;
