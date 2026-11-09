-- VIL-599 · who said a family memory fact, and so which adult may hear it back
-- (decision R7: co-parents share logistics; anything else said in one adult's 1:1
-- stays theirs). `source_audience` says where it was said; `source_user_id` names the
-- adult who said it. A row saved before this column existed is `unrecorded`: Hale
-- cannot say whose it is, so a non-logistics fact is held back from every adult while
-- another adult is on record for the family. Nothing is backfilled or rewritten.
-- Additive (rule #9). Re-runnable: IF NOT EXISTS, and the CHECK is dropped and re-added.
-- Reversible (after the index rollback at the bottom):
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
--> statement-breakpoint
-- A fact's live identity names whose private fact it is. One live row per
-- (family, child, type, key) meant A's private fact and B's private fact on one key
-- could not both be live, so every write either overwrote the other adult's fact or
-- refused in a way that showed it was there. The fifth column is the speaker of a
-- private fact (said in their 1:1, and not a logistic, routine, calendar or receipt
-- fact, which R7 shares) and NULL for the household's. A private row whose speaker is
-- deleted (`source_user_id` ON DELETE SET NULL) is scoped to its own id, so a user
-- delete can never collide with a household row. `liveScopeSql`
-- (apps/worker/src/services/memory-context.ts) is the same expression.
-- This only loosens the rule between different adults' private rows; no row changes.
-- The new index is created FIRST, so the table is never without one.
-- Rollback (repair cross-scope duplicates the way 0084 did, then restore the old index):
--   WITH ranked AS (SELECT id, first_value(id) OVER (PARTITION BY family_id, child_id,
--     fact_type, fact_key ORDER BY confidence DESC, valid_from DESC, created_at DESC,
--     id DESC) AS winner_id FROM family_memory_facts WHERE valid_until IS NULL)
--   UPDATE family_memory_facts AS f SET valid_until = now(), superseded_by = ranked.winner_id
--     FROM ranked WHERE f.id = ranked.id AND ranked.winner_id <> f.id;
--   CREATE UNIQUE INDEX IF NOT EXISTS "memory_facts_one_live_per_key_idx" ON
--     "family_memory_facts" ("family_id","child_id","fact_type","fact_key")
--     NULLS NOT DISTINCT WHERE "valid_until" IS NULL;
--   DROP INDEX IF EXISTS "memory_facts_one_live_per_scope_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "memory_facts_one_live_per_scope_idx"
  ON "family_memory_facts" (
    "family_id",
    "child_id",
    "fact_type",
    "fact_key",
    (CASE
      WHEN "source_audience" = 'one_to_one'
        AND "fact_type" NOT IN ('logistic', 'routine')
        AND "memory_source" NOT IN ('calendar', 'receipt')
      THEN coalesce("source_user_id", "id")
    END)
  )
  NULLS NOT DISTINCT
  WHERE "valid_until" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "memory_facts_one_live_per_key_idx";
