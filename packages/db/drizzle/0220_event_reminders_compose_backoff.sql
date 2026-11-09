-- VIL-625 · a reminder held because the writer could not be reached records how many
-- times it was tried and when it may be tried next, so the drain backs off instead of
-- asking the writer every minute, and the hold ends after a bounded number of tries.
-- Additive (rule #9). Two columns, no rewrite. Re-runnable: IF NOT EXISTS. Reversible:
--   ALTER TABLE event_reminders DROP COLUMN IF EXISTS compose_attempts,
--     DROP COLUMN IF EXISTS compose_next_try_at;

ALTER TABLE "event_reminders" ADD COLUMN IF NOT EXISTS "compose_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_reminders" ADD COLUMN IF NOT EXISTS "compose_next_try_at" timestamp with time zone;
