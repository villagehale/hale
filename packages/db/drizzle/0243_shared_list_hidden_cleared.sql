-- VIL-687 follow-up: a hidden gift is shown only to the people who were in the chat when it
-- was hidden, were not the child's family, and have not left since.
--
-- A presence row is deleted when its person leaves and a new one is written when they come
-- back, so hidden_from_person_ids alone stopped hiding a gift from a parent who left and
-- rejoined, and what Hale learned about someone on their old seat ("I'm Mia's mom") is gone
-- with it. hidden_cleared_phone_hashes holds the blind index (linq_shared_group_people.
-- phone_e164_hash) of each person cleared to see it. Anyone else in the chat hides it, and
-- leaving or family erasure takes a number off, so a rejoin counts as someone new and no
-- number is kept past its seat.
--
-- The backfill clears, for each item already hidden, the people seated in its chat now who
-- are not named on it and not in a named family. Anyone it misses is hidden from (fail
-- closed); anyone it clears who is the child's family is still hidden from by the read-time
-- check while they are here, and is taken off when they leave.
--
-- Additive. Re-runnable: IF NOT EXISTS, and the backfill only fills empty arrays.
--
-- Reversible:
--   ALTER TABLE shared_group_list_items DROP COLUMN IF EXISTS hidden_cleared_phone_hashes;
ALTER TABLE "shared_group_list_items" ADD COLUMN IF NOT EXISTS "hidden_cleared_phone_hashes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "shared_group_list_items" AS "item"
SET "hidden_cleared_phone_hashes" = ARRAY(
	SELECT DISTINCT "person"."phone_e164_hash"
	FROM "linq_shared_group_people" AS "person"
	WHERE "person"."chat_id" = "item"."chat_id"
		AND NOT ("person"."id" = ANY("item"."hidden_from_person_ids"))
		AND ("person"."family_id" IS NULL OR NOT ("person"."family_id" = ANY("item"."hidden_from_family_ids")))
)
WHERE ("item"."hidden_for_kid" IS NOT NULL
		OR cardinality("item"."hidden_from_person_ids") > 0
		OR cardinality("item"."hidden_from_family_ids") > 0)
	AND cardinality("item"."hidden_cleared_phone_hashes") = 0;
