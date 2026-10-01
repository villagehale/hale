-- VIL-402 — a no-picks travel brief waits, and the wait grows.
--
-- Additive (rule #9). Two nullable timestamps. Existing rows stay valid:
-- both null means the live search has not come back empty yet. Re-runnable:
-- ADD COLUMN IF NOT EXISTS, and the checks are added inside a duplicate-object
-- guard. Nothing is deleted and nothing is rewritten.
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
