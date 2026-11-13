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
-- An item hidden before this migration starts with nobody cleared (fail closed): who was in
-- the chat when it was hidden was never recorded, and clearance is never added later. The
-- group can hide it again. A seat that already gave a family role without a child is kept as
-- a claim on an unnamed child.
--
-- Additive. Re-runnable: IF NOT EXISTS, and each backfill only ever adds a claim, so a re-run
-- never adds clearance.
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
UPDATE "linq_shared_group_people"
SET "claims_unnamed_kid" = true
WHERE "inferred_role" IS NOT NULL
	AND "inferred_role" NOT IN ('guest', 'unclear')
	AND "inferred_kid_name" IS NULL
	AND cardinality("inferred_kid_names") = 0;
