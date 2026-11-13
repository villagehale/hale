-- VIL-687 follow-up: a hidden gift is hidden from a NUMBER, not from a presence row.
--
-- A presence row is deleted when its person leaves and a new one is written when they come
-- back, so hidden_from_person_ids alone stopped hiding a gift from a parent who left and
-- rejoined. hidden_from_phone_hashes holds the blind index (linq_shared_group_people.
-- phone_e164_hash) of each person the gift is hidden from, which survives leave and rejoin.
-- hidden_cleared_phone_hashes holds the numbers that were in the chat when it was hidden and
-- were not the child's family: once someone it is hidden from is gone, only those may see it.
--
-- The backfill copies the hash of every named person who is still seated. A named person
-- who already left keeps only their old id, and code then hides the item from everyone not
-- cleared, which is everyone on an old row (fail closed).
--
-- Additive. Re-runnable: IF NOT EXISTS, and the backfill only fills empty arrays.
--
-- Reversible:
--   ALTER TABLE shared_group_list_items DROP COLUMN IF EXISTS hidden_cleared_phone_hashes;
--   ALTER TABLE shared_group_list_items DROP COLUMN IF EXISTS hidden_from_phone_hashes;
ALTER TABLE "shared_group_list_items" ADD COLUMN IF NOT EXISTS "hidden_from_phone_hashes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_group_list_items" ADD COLUMN IF NOT EXISTS "hidden_cleared_phone_hashes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "shared_group_list_items" AS "item"
SET "hidden_from_phone_hashes" = ARRAY(
	SELECT DISTINCT "person"."phone_e164_hash"
	FROM "linq_shared_group_people" AS "person"
	WHERE "person"."id" = ANY("item"."hidden_from_person_ids")
)
WHERE cardinality("item"."hidden_from_person_ids") > 0
	AND cardinality("item"."hidden_from_phone_hashes") = 0;
