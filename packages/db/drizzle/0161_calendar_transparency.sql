-- Whether a calendar entry is a real commitment or a free/transparent mark.
--
-- An all-day "out of office" that Google marks transparent must not make Saturday
-- look full, and a timed study block must not either. Null means the feed did not
-- say: a confirmed all-day entry stays a commitment.
--
-- Additive (rule #9). Re-runnable.

ALTER TABLE "calendar_event_snapshots" ADD COLUMN IF NOT EXISTS "transparency" text;
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "transparency" text;
