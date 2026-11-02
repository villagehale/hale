-- The medical last resort is the said-line writer, not a preset sentence. The column
-- value was `fixed`, the same word as a provider-door line. Rename the stored rows
-- and the CHECK. Provider-door `reply_source` stays `fixed`. A medical row that also
-- carried `reply_source = 'fixed'` is renamed with it, because the lane copies the
-- medical outcome onto both columns.
--
-- Re-runnable. The checks come off first (IF EXISTS): `said_line` is not in the
-- old lists, so the UPDATEs would fail while those constraints still stand. Each
-- check is added inside a duplicate-object guard. A second run drops the new
-- checks, finds no `fixed` medical rows left to rename, and adds the same checks
-- again.
ALTER TABLE "public"."channel_messages"
  DROP CONSTRAINT IF EXISTS "channel_messages_reply_source_check";
--> statement-breakpoint
ALTER TABLE "public"."channel_messages"
  DROP CONSTRAINT IF EXISTS "channel_messages_medical_reply_source_check";
--> statement-breakpoint
UPDATE "public"."channel_messages"
  SET "reply_source" = 'said_line'
  WHERE "medical_reply_source" = 'fixed'
    AND "reply_source" = 'fixed';
--> statement-breakpoint
UPDATE "public"."channel_messages"
  SET "medical_reply_source" = 'said_line'
  WHERE "medical_reply_source" = 'fixed';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "public"."channel_messages"
    ADD CONSTRAINT "channel_messages_medical_reply_source_check"
    CHECK ("medical_reply_source" IS NULL OR "medical_reply_source" IN (
      'web_grounded', 'said_line'
    ));
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "public"."channel_messages"
    ADD CONSTRAINT "channel_messages_reply_source_check"
    CHECK ("reply_source" IS NULL OR "reply_source" IN (
      'fixed', 'composed', 'web_grounded', 'said_line',
      'client_unavailable', 'skill_unavailable', 'model_failed', 'unsendable'
    ));
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;
