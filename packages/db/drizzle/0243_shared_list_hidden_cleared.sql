-- VIL-687 follow-up: a hidden gift is shown only to the people who were in the chat, seated
-- and cleared when it was hidden. Everyone else in the chat (new, unseated, rejoined, stopped,
-- unknown) hides it, and clearance is only ever taken away after the hide.
--
-- A presence row is deleted when its person leaves and a new one is written when they come
-- back, so hidden_from_person_ids alone stopped hiding a gift from a parent who left and
-- rejoined, and what Hale learned about someone on their old seat ("I'm Mia's mom") is gone
-- with it. hidden_cleared_phone_hashes holds the blind index (linq_shared_group_people.
-- phone_e164_hash) of each person cleared to see it. Leaving or family erasure takes a number
-- off, so a rejoin counts as someone new and no number is kept past its seat.
--
-- inferred_kid_names is every child a person said in the chat they are family of, grow-only
-- while the seat lives (inferred_kid_name kept only the latest). claims_unnamed_kid is a
-- person who said they are a child's family without naming the child. Both are presence
-- data and go with the seat.
--
-- The backfill clears, for each item already hidden, the people seated in its chat now who
-- have not stopped, are not named on it and not in a named family. Anyone it misses is hidden
-- from (fail closed); anyone it clears who is the child's family is still hidden from by the
-- read-time check while they are here, and is taken off when they leave.
--
-- Additive. Re-runnable: IF NOT EXISTS, and the backfills only fill empty arrays.
--
-- Reversible:
--   ALTER TABLE shared_group_list_items DROP COLUMN IF EXISTS hidden_cleared_phone_hashes;
--   ALTER TABLE linq_shared_group_people DROP COLUMN IF EXISTS inferred_kid_names;
--   ALTER TABLE linq_shared_group_people DROP COLUMN IF EXISTS claims_unnamed_kid;
ALTER TABLE "shared_group_list_items" ADD COLUMN IF NOT EXISTS "hidden_cleared_phone_hashes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "linq_shared_group_people" ADD COLUMN IF NOT EXISTS "inferred_kid_names" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "linq_shared_group_people" ADD COLUMN IF NOT EXISTS "claims_unnamed_kid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "linq_shared_group_people"
SET "inferred_kid_names" = ARRAY["inferred_kid_name"]
WHERE "inferred_kid_name" IS NOT NULL
	AND cardinality("inferred_kid_names") = 0;--> statement-breakpoint
UPDATE "shared_group_list_items" AS "item"
SET "hidden_cleared_phone_hashes" = ARRAY(
	SELECT DISTINCT "person"."phone_e164_hash"
	FROM "linq_shared_group_people" AS "person"
	WHERE "person"."chat_id" = "item"."chat_id"
		AND "person"."stopped_at" IS NULL
		AND NOT ("person"."id" = ANY("item"."hidden_from_person_ids"))
		AND ("person"."family_id" IS NULL OR NOT ("person"."family_id" = ANY("item"."hidden_from_family_ids")))
)
WHERE ("item"."hidden_for_kid" IS NOT NULL
		OR cardinality("item"."hidden_from_person_ids") > 0
		OR cardinality("item"."hidden_from_family_ids") > 0)
	AND cardinality("item"."hidden_cleared_phone_hashes") = 0;
