-- FEEDBACK THAT REACHES THE NEXT PARENT. One row per family per subject: what one
-- household said about one public venue, reduced to a closed verdict and at most three
-- tags from a closed list. Additive (rule #9): one new table, nothing altered.
--
-- WHAT IS ABSENT IS THE POINT.
--   · The parent's SENTENCE is not here and is stored nowhere. Free text never crosses a
--     family boundary: a quoted line is re-identifying at k=3 and a tag is not. Structural
--     rather than remembered — there is no column a future reader could fill.
--   · The PROVIDER'S NAME is not here. The display name comes from the finder's own live
--     row at read time, because the reader is always about to show the parent that
--     activity anyway. A name Hale never stores is a name Hale can never defame.
--   · child_id is not here. An age BAND only, and 'teenager' is unwritable by anybody
--     including a future backfill (rule #1).
--   · There is no materialised aggregate. count(*) over the unique index below IS
--     count(distinct family_id), so erasure needs no recompute: the cascade takes the
--     rows and the next read is already the new answer.
--
-- WHY NO REFERENCES village_candidates. That table is per-family and soft-retired by
-- supersession, so an FK would make the aggregation key per-family and k>=3 structurally
-- unreachable. subject_ref is an OPAQUE COMPARED STRING, never parsed.
--
-- The family_id cascade IS the erasure path (rule #1, PIPEDA): runDeletionSweep issues
-- one DELETE FROM families and the rows go with it.
CREATE TABLE IF NOT EXISTS "activity_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	-- The inbound row that carried the words. Erasing the message erases the verdict
	-- derived from it, which is the same provenance-both-ways the day notes keep.
	"source_message_id" uuid NOT NULL REFERENCES "channel_messages"("id") ON DELETE cascade,
	-- The shared identity this opinion is ABOUT. Two members, both venue-grain and both
	-- global: a Google place id, or a civic_venues row.
	"subject_source" text NOT NULL,
	"subject_ref" text NOT NULL,
	-- matchAreaKey's coarse area, stamped at write time so the count is a pure scan with
	-- no join to live family state (rule #1 — an FSA, never a home).
	"area_key" text NOT NULL,
	"child_age_band" text,
	"verdict" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_reviews_subject_source_check"
		CHECK ("subject_source" IN ('place','civic_venue')),
	CONSTRAINT "activity_reviews_verdict_check"
		CHECK ("verdict" IN ('worth_it','not_worth_it','did_not_attend')),
	CONSTRAINT "activity_reviews_age_band_check"
		CHECK ("child_age_band" IS NULL OR "child_age_band" IN ('newborn','toddler','preschool','child')),
	CONSTRAINT "activity_reviews_tags_check"
		CHECK ("tags" <@ ARRAY['well_run','disorganised','too_crowded','easy_parking',
		                       'hard_parking','good_age_fit','wrong_age_fit','pricey']::text[]
		       AND coalesce(array_length("tags",1),0) <= 3)
);--> statement-breakpoint

ALTER TABLE "activity_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ONE OPINION PER HOUSEHOLD PER SUBJECT, and this index is the k>=3 guarantee rather
-- than a tidiness rule: with it, count(*) IS count(distinct family_id), so a reader who
-- forgets DISTINCT cannot inflate the threshold. A second answer from the same family is
-- a correction, not a second voice.
CREATE UNIQUE INDEX IF NOT EXISTS "activity_reviews_family_subject_uniq"
	ON "activity_reviews" ("family_id","subject_source","subject_ref");--> statement-breakpoint

-- The aggregate read's working set.
CREATE INDEX IF NOT EXISTS "activity_reviews_subject_idx"
	ON "activity_reviews" ("subject_source","subject_ref","area_key");
