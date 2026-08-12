-- MEM-3 · one live fact per key.
--
-- `family_memory_facts` is bi-temporal: a fact stops being true when `valid_until`
-- is stamped, and its replacement points back via `superseded_by`. Nothing enforced
-- that, so a family could hold two contradictory live rows on the same key -- "Ella
-- is potty training" and "Ella is potty trained" -- with no ordering signal to say
-- which Hale should believe. Two writers (health check-ins, registration outcomes)
-- never superseded at all and simply appended.
--
-- The repair runs FIRST, in the same migration as the index, because production
-- already holds those duplicates and `CREATE UNIQUE INDEX` against them would fail
-- the deploy. Additive only (hard rule #9): no column or row is dropped -- losing
-- rows are closed and linked, which is the same shape a normal supersede leaves.

-- Retire every duplicate live fact except the one worth keeping. The winner is the
-- most-trusted row (highest confidence), then the most recent, matching the order
-- the coach now reads facts in -- so the row that survives the repair is the row the
-- coach was most likely already seeing. `first_value` partitions NULL child_ids
-- together, the same grouping the index below uses.
WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY family_id, child_id, fact_type, fact_key
      ORDER BY confidence DESC, valid_from DESC, created_at DESC, id DESC
    ) AS winner_id
  FROM family_memory_facts
  WHERE valid_until IS NULL
)
UPDATE family_memory_facts AS f
SET valid_until = now(),
    superseded_by = ranked.winner_id
FROM ranked
WHERE f.id = ranked.id
  AND ranked.winner_id <> f.id;
--> statement-breakpoint
-- NULLS NOT DISTINCT is the load-bearing clause. By default Postgres treats NULLs as
-- distinct in a unique index, which would exempt every family-wide fact (child_id
-- IS NULL) -- the majority of them -- and leave the constraint enforcing almost
-- nothing. Partial on `valid_until IS NULL` so history stays unconstrained: a key may
-- have any number of retired rows, and exactly one live one.
CREATE UNIQUE INDEX IF NOT EXISTS "memory_facts_one_live_per_key_idx"
  ON "family_memory_facts" ("family_id","child_id","fact_type","fact_key")
  NULLS NOT DISTINCT
  WHERE "valid_until" IS NULL;
