-- VIL-273 (off-domain capability lane) — two additive nullable columns, one check,
-- one partial index. Nothing existing changes shape or default.
--
-- WHY HERE AND NOT A NEW TABLE. "A parent asked Hale for something it does not do, and
-- this is the bucket it falls in" is a fact about ONE INBOUND MESSAGE. The inbound row
-- already exists, is already family-scoped, already cascades on family deletion (so the
-- signal cannot outlive an erasure request — the gap a separate table would have had to
-- re-close in runDeletionSweep), and is already the table the weekly founder digest
-- reads a 7-day window out of. A second table would have duplicated all four properties
-- to hold two strings.
--
-- WHY TWO COLUMNS AND A CHECK. The lane (which fixed line was sent) and the category
-- (what the parent wanted) are two different questions, and a row carrying one without
-- the other is a signal nobody can read. The check makes that row unwritable rather
-- than merely unlikely.
--
-- NO RAW TEXT, EVER. `unmet_category` holds one value from a closed vocabulary the
-- screening skill may choose from and a code-side allowlist re-checks; it can never
-- carry a child's name, a symptom, or anything the parent typed (rule #1). The verbatim
-- message is already in `body` on this same row, under the existing inbound convention
-- — this adds no new copy of it.
--
-- Stored as text with Drizzle $type<> unions rather than new enum types (the
-- content_provenance / classifier_suggestion precedent): @hale/db is a leaf package and
-- the closed sets are enforced in TypeScript.
ALTER TABLE "public"."channel_messages"
  ADD COLUMN IF NOT EXISTS "unmet_lane" text;
--> statement-breakpoint
ALTER TABLE "public"."channel_messages"
  ADD COLUMN IF NOT EXISTS "unmet_category" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "public"."channel_messages"
    ADD CONSTRAINT "channel_messages_unmet_pair_check"
    CHECK (("unmet_lane" IS NULL) = ("unmet_category" IS NULL));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_unmet_idx"
  ON "public"."channel_messages" ("created_at")
  WHERE "unmet_lane" IS NOT NULL;
