-- Source attribution on the family itself: the `(via <code>)` / `HALE <CODE>` tag the
-- first text carried, so channel reporting does not need a join through intake sessions.
-- Additive and nullable; no data is rewritten. The backfill from sms_intake_sessions is
-- a separate, manually-run statement (see the PR body), not part of this migration.
-- Reversible:
--   ALTER TABLE "families" DROP COLUMN "source_code";
ALTER TABLE "families" ADD COLUMN IF NOT EXISTS "source_code" text;
