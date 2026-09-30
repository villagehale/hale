-- VIL-391 — kind, source, and expiry on family memory facts.
-- Additive (rule #9). Re-runnable: ADD COLUMN IF NOT EXISTS, and CHECK
-- constraints are guarded. Existing rows backfill as lasting / legacy so a
-- reader that ignores the columns is unchanged. sourced_at copies created_at
-- rather than the migration clock.
--
-- Reversible: drop the three CHECKs, then
--   ALTER TABLE family_memory_facts
--     DROP COLUMN IF EXISTS signal_count,
--     DROP COLUMN IF EXISTS expires_at,
--     DROP COLUMN IF EXISTS sourced_at,
--     DROP COLUMN IF EXISTS memory_source,
--     DROP COLUMN IF EXISTS memory_kind;

ALTER TABLE "family_memory_facts"
  ADD COLUMN IF NOT EXISTS "memory_kind" text DEFAULT 'lasting' NOT NULL;--> statement-breakpoint

ALTER TABLE "family_memory_facts"
  ADD COLUMN IF NOT EXISTS "memory_source" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint

ALTER TABLE "family_memory_facts"
  ADD COLUMN IF NOT EXISTS "sourced_at" timestamp with time zone;--> statement-breakpoint

UPDATE "family_memory_facts"
  SET "sourced_at" = "created_at"
  WHERE "sourced_at" IS NULL;--> statement-breakpoint

ALTER TABLE "family_memory_facts"
  ALTER COLUMN "sourced_at" SET DEFAULT now();--> statement-breakpoint

ALTER TABLE "family_memory_facts"
  ALTER COLUMN "sourced_at" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "family_memory_facts"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "family_memory_facts"
  ADD COLUMN IF NOT EXISTS "signal_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_memory_facts"
    ADD CONSTRAINT "family_memory_facts_kind_chk"
    CHECK ("memory_kind" IN ('lasting', 'temporary', 'one_off'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_memory_facts"
    ADD CONSTRAINT "family_memory_facts_source_chk"
    CHECK ("memory_source" IN ('parent_message', 'calendar', 'receipt', 'inferred', 'legacy'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_memory_facts"
    ADD CONSTRAINT "family_memory_facts_temporary_expiry_chk"
    CHECK ("memory_kind" <> 'temporary' OR "expires_at" IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
