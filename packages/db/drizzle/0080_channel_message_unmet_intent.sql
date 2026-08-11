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
-- NO RAW TEXT, EVER — and the CHECK below is what makes that true rather than intended.
-- `unmet_category` is written from a model's reading of a family's PRIVATE MESSAGE, and
-- it is rendered into the founder's weekly email. A code-side allowlist alone would put
-- that guarantee in one function three files away from the email that depends on it, so
-- any future writer, backfill or manual UPDATE could land a sentence a parent typed in
-- an outbound message. Enumerating the vocabulary here makes the bad row unwritable by
-- anybody, forever; the cost is that adding a bucket needs a migration, which is the
-- correct price for a column with that blast radius. (The verbatim message is already in
-- `body` on this same row under the existing inbound convention — this adds no new copy
-- of it.) Rule #1.
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
DO $$ BEGIN
  ALTER TABLE "public"."channel_messages"
    ADD CONSTRAINT "channel_messages_unmet_lane_check"
    CHECK ("unmet_lane" IS NULL OR "unmet_lane" IN (
      'off_domain_general', 'safety_critical', 'provider_access'
    ));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "public"."channel_messages"
    ADD CONSTRAINT "channel_messages_unmet_category_check"
    CHECK ("unmet_category" IS NULL OR "unmet_category" IN (
      'weather', 'news-or-politics', 'general-knowledge', 'nearby-places',
      'traffic-or-transit', 'shopping-or-deals', 'other', 'medical-symptom',
      'mental-health', 'child-safety', 'emergency', 'doctor-access',
      'specialist-access'
    ));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_unmet_idx"
  ON "public"."channel_messages" ("created_at")
  WHERE "unmet_lane" IS NOT NULL;
