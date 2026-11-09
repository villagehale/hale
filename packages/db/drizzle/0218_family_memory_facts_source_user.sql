-- VIL-599 · who said a family memory fact, and so which adult may hear it back
-- (decision R7: co-parents share logistics; anything else said in one adult's 1:1
-- stays theirs). `source_audience` says where it was said; `source_user_id` names the
-- adult who said it. A row saved before this column existed is `unrecorded`: Hale
-- cannot say whose it is, so a non-logistics fact is held back from every adult while
-- another adult is on record for the family. Nothing is backfilled or rewritten.
-- Additive (rule #9). Re-runnable: IF NOT EXISTS, and the CHECK is dropped and re-added.
-- Reversible:
--   ALTER TABLE family_memory_facts DROP CONSTRAINT IF EXISTS family_memory_facts_source_audience_chk;
--   ALTER TABLE family_memory_facts DROP COLUMN IF EXISTS source_audience;
--   ALTER TABLE family_memory_facts DROP COLUMN IF EXISTS source_user_id;

ALTER TABLE "family_memory_facts" ADD COLUMN IF NOT EXISTS "source_user_id" uuid REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "family_memory_facts" ADD COLUMN IF NOT EXISTS "source_audience" text DEFAULT 'unrecorded' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "family_memory_facts" DROP CONSTRAINT IF EXISTS "family_memory_facts_source_audience_chk";
  ALTER TABLE "family_memory_facts" ADD CONSTRAINT "family_memory_facts_source_audience_chk"
    CHECK ("source_audience" IN ('one_to_one', 'family', 'unrecorded'));
END $$;
