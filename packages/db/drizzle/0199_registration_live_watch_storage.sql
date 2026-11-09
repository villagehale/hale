-- VIL-423 · 4a · a registration watch can hang off the LINK a parent sent, before the
-- city has posted dates and without a registration_windows catalog row. Additive (rule
-- #9): one DROP NOT NULL, seven nullable columns, two CHECKs loosened under their own
-- names, two new CHECKs, two partial indexes. Re-runnable: the deploy leg re-runs every
-- file past the ledger watermark (PRs #609/#610), so every statement is IF [NOT] EXISTS
-- or a DO block.
--
-- NOT VALID on every new or replaced CHECK, by ruling: nobody has counted prod's rows,
-- so the apply must not re-scan them (a legacy empty course_url would fail the new lower
-- bound). New writes and updates are checked. Follow-up: VALIDATE CONSTRAINT after a
-- prod count.
--
-- The replaced constraints KEEP their names: 0110 and 0111 add them inside
-- duplicate_object guards, so a replay of either after this file is a no-op and never
-- puts the tighter limit back.
--
-- No column holds a credential, a price or a child's name. child_id is an optional link
-- to the children row, and it CASCADES: the link names the exact class that child is
-- being registered for, so erasing the child erases the watch (a family-level watch,
-- child_id NULL, cascades from families as before).

ALTER TABLE "registration_sequences" ALTER COLUMN "window_id" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "registration_sequences"
  ADD COLUMN IF NOT EXISTS "child_id" uuid REFERENCES "children"("id") ON DELETE cascade,
  ADD COLUMN IF NOT EXISTS "last_reading" jsonb,
  ADD COLUMN IF NOT EXISTS "last_read_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "next_check_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "pending_change" jsonb,
  ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "date_review_action_id" uuid REFERENCES "actions"("id") ON DELETE set null;
--> statement-breakpoint

-- The URL/date pairing now binds only window-bound rows (the ladder's own guarantee); a
-- link-owned watch may hold a URL with no date yet. DROP and ADD share ONE block, so a
-- hand-apply can never leave the table with neither.
DO $$ BEGIN
  ALTER TABLE "registration_sequences" DROP CONSTRAINT IF EXISTS "registration_sequences_course_check";
  ALTER TABLE "registration_sequences" ADD CONSTRAINT "registration_sequences_course_check"
    CHECK ("window_id" IS NULL OR ("course_url" IS NULL) = ("course_opens_at" IS NULL)) NOT VALID;
END $$;
--> statement-breakpoint

-- 2048 = REGISTRATION_COURSE_URL_MAX_CHARS, pinned by url-check-consistency.test.ts.
-- Counted in BYTES: live_url_uniq below is a btree on the raw text, whose row limit is
-- 2704 bytes, so a character bound would let a multibyte link past this named check and
-- into an unnamed index error. A serialized URL is ASCII, so for it bytes = characters.
DO $$ BEGIN
  ALTER TABLE "registration_sequences" DROP CONSTRAINT IF EXISTS "registration_sequences_course_url_length_check";
  ALTER TABLE "registration_sequences" ADD CONSTRAINT "registration_sequences_course_url_length_check"
    CHECK ("course_url" IS NULL OR octet_length("course_url") BETWEEN 1 AND 2048) NOT VALID;
END $$;
--> statement-breakpoint

-- A watch hangs off a catalog window or a link; a row with neither watches nothing.
DO $$ BEGIN
  ALTER TABLE "registration_sequences" ADD CONSTRAINT "registration_sequences_target_check"
    CHECK ("window_id" IS NOT NULL OR "course_url" IS NOT NULL) NOT VALID;
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint

-- A date-review card exists only for a change the page showed.
DO $$ BEGIN
  ALTER TABLE "registration_sequences" ADD CONSTRAINT "registration_sequences_date_review_check"
    CHECK ("date_review_action_id" IS NULL OR "pending_change" IS NOT NULL) NOT VALID;
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint

-- A link-owned watch's identity: one ACTIVE watch per family and link. Window-bound rows
-- keep (family_id, window_id); NULL window ids never collide there.
CREATE UNIQUE INDEX IF NOT EXISTS "registration_sequences_live_url_uniq"
  ON "registration_sequences" ("family_id", "course_url")
  WHERE "window_id" IS NULL AND ("outcome" IS NULL OR "outcome" = 'waitlisted');
--> statement-breakpoint

-- The refresh scan: live watches by when they are next due.
CREATE INDEX IF NOT EXISTS "registration_sequences_check_idx"
  ON "registration_sequences" ("next_check_at")
  WHERE "next_check_at" IS NOT NULL AND ("outcome" IS NULL OR "outcome" = 'waitlisted');
