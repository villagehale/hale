-- family_trips.last_attempt_at / next_attempt_at, applied where 0144 cannot run.
--
-- 0144_family_trips_no_picks_backoff already adds these columns. Prod will never
-- run that file: its journal `when` (1781469638000) was recorded when the reverted
-- 0144_linq_contact_card_shares migration applied, and drizzle applies an entry
-- only when `when` is greater than max(created_at). The nudge cron's travel-brief
-- select reads last_attempt_at, so a database watermarked at 0149 is missing the
-- column. This file is the same additive DDL with a later `when`.
--
-- Additive (rule #9). Nullable, so existing rows stay valid. Re-runnable:
-- ADD COLUMN IF NOT EXISTS, and the checks are inside a duplicate-object guard.
-- A database that already applied 0144 (fresh migrate, tests) no-ops both.
--
-- Reversible:
--   ALTER TABLE family_trips DROP CONSTRAINT IF EXISTS family_trips_attempt_order_check;
--   ALTER TABLE family_trips DROP CONSTRAINT IF EXISTS family_trips_attempt_pair_check;
--   ALTER TABLE family_trips
--     DROP COLUMN IF EXISTS next_attempt_at,
--     DROP COLUMN IF EXISTS last_attempt_at;

ALTER TABLE "family_trips" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "family_trips" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_trips"
    ADD CONSTRAINT "family_trips_attempt_pair_check"
    CHECK (("last_attempt_at" IS NULL) = ("next_attempt_at" IS NULL));
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_trips"
    ADD CONSTRAINT "family_trips_attempt_order_check"
    CHECK ("next_attempt_at" IS NULL OR "next_attempt_at" >= "last_attempt_at");
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;
