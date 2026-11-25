-- VIL-776 · a queued proactive line keeps the role-scope content class its sweep asked the
-- group-audience rule about, so the hourly review can ask it again before a group send.
-- Nullable: a row queued before this column, or a line with no class, stays 1:1.
-- No backfill, and no text, phone number, name or id is added (rule #1).
-- Add-only (rule #9). Re-runnable. Reversible:
--   ALTER TABLE "proactive_candidates" DROP COLUMN IF EXISTS "content_class";
ALTER TABLE "proactive_candidates" ADD COLUMN IF NOT EXISTS "content_class" text;
