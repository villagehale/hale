-- THE SESSION, AS ONE STORED STRING — what makes "two other Hale families are in this
-- class" a count rather than a guess. Additive (rule #9): one nullable column and one
-- index on a table that ships empty, so an unbackfilled row is byte-for-byte today's
-- behaviour (a NULL key is never counted and never counted about).
--
-- WHY A COLUMN AND NOT A FOUR-FIELD COMPARISON IN THE READ. The key is `provider_host`,
-- the folded title and the first instant, and folding it in the query means writing that
-- normalisation in SQL beside the TypeScript copy that wrote the row. Two languages, one
-- rule, and the day they disagree the count silently drops to zero and reads exactly like
-- an empty room. Stored once at write time by one exported function, it is compared by
-- plain equality here and there is no second definition to drift.
--
-- WHY NULLABLE, AND WHY NULL IS THE ONLY REFUSAL. A fallback title (Hale's own words, so
-- every nameless receipt from one host at one instant would key into one "session"), a
-- freemail sender (a coach on gmail.com makes the host a collision engine across unrelated
-- senders), and a title that folds to nothing all yield NULL. A NULL-keyed booking is a
-- real booking whose follow-up still asks; it is simply not countable in EITHER direction.
--
-- IT DISCLOSES NOTHING NEW. The three parts are already three columns on the same row, and
-- it lives inside the same family cascade — erasure is still one DELETE FROM families.
ALTER TABLE "activity_bookings"
	ADD COLUMN IF NOT EXISTS "session_key" text;--> statement-breakpoint

-- The count reads ACROSS families on one key, so the existing (family_id, first_session_at)
-- due index cannot serve it. PARTIAL, unlike that one: the due window is relative to `now`
-- and has no constant predicate, while a cancelled booking is never counted by anybody.
CREATE INDEX IF NOT EXISTS "activity_bookings_session_idx"
	ON "activity_bookings" ("session_key")
	WHERE "cancelled_at" IS NULL;

-- BUILDER NOTES:
--  * `cancelled_at` is NOT re-added: it landed inside 0121 itself.
--  * ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS are the re-runnable shapes the
--    Deploy migrate leg needs past the ledger watermark (migration-rerunnable.test.mjs,
--    and the pglite double-apply test that is the real gate).
--  * No new table, so migration-rls-consistency.test.mjs does not fire; RLS is already on
--    "activity_bookings" from 0121. No enum and no CHECK, so no vocabulary test.
