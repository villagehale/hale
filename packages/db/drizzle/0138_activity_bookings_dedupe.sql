-- THE CLASS, as one stored string — what makes an invoice and the receipt that follows
-- it one booking rather than two. Additive (rule #9): one nullable column and one
-- partial unique index. An unbackfilled row is unchanged: a NULL key is not unique
-- (Postgres treats nulls as distinct) and the readers recompute the key from the
-- columns the row already has.
--
-- NO BACKFILL. Two legacy rows for one class would make CREATE UNIQUE INDEX fail, and
-- deleting one of them is not an additive migration. New writes set the key. A later
-- receipt refreshes the oldest live row. The follow-up reader collapses whatever is
-- left, so a second "how did it go?" does not go out for the pair.
--
-- WHY A COLUMN AND NOT A COMPARISON IN THE UNIQUE INDEX. The key is the sender domain,
-- the canonical title (case, whitespace, weekday abbreviations) and the UTC date.
-- Folding that in the index means writing the weekday table in SQL beside the
-- TypeScript copy. Stored once at write time, the race between two receipts conflicts
-- here instead of minting a second class.
ALTER TABLE "activity_bookings"
	ADD COLUMN IF NOT EXISTS "dedupe_key" text;--> statement-breakpoint

-- PARTIAL: a cancelled booking drops out, so the same class can be registered again.
-- NULL keys are excluded by the predicate — they are the legacy rows this migration
-- deliberately does not try to merge.
CREATE UNIQUE INDEX IF NOT EXISTS "activity_bookings_dedupe_uniq"
	ON "activity_bookings" ("family_id", "dedupe_key")
	WHERE "cancelled_at" IS NULL AND "dedupe_key" IS NOT NULL;
