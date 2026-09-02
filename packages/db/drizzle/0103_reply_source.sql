-- The off-domain deflection's reply provenance, on the reply it sent. One additive
-- nullable column, one check, one partial index — the exact shape 0090 shipped for the
-- medical lane, generalized to the whole deflection branch. Nothing existing changes.
--
-- WHY. Every deflection already carries an in-memory `replySource` naming where the
-- words came from ('composed', 'web_grounded', a fixed door, or one of the four named
-- reasons the composer could not run) — and the router dropped it at the send seam, so
-- the weekly deflection count silently mixed real answers with ANSWER_UNAVAILABLE sends
-- (scorecard-rubric documents this exact invisibility for the medical case that got its
-- own column). The papercut digest needs the split, so the fact moves to the row.
--
-- WHY ON THE OUTBOUND ROW. Same reasoning as 0090: it is a fact about the REPLY, not
-- the question — the inbound row keeps the demand signal (unmet_lane/unmet_category)
-- and the outbound row keeps what Hale actually said in response.
--
-- NO TEXT, NO PII. A closed seven-value vocabulary, enumerated in the database so no
-- future writer, backfill or manual UPDATE can land a sentence here; `body` stays null
-- on outbound rows under the existing convention. Rule #1.
ALTER TABLE "public"."channel_messages"
  ADD COLUMN IF NOT EXISTS "reply_source" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "public"."channel_messages"
    ADD CONSTRAINT "channel_messages_reply_source_check"
    CHECK ("reply_source" IS NULL OR "reply_source" IN (
      'fixed', 'composed', 'web_grounded',
      'client_unavailable', 'skill_unavailable', 'model_failed', 'unsendable'
    ));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- The papercut digest's weekly window over deflection replies. Partial, like the unmet
-- and medical indexes beside it, so it covers the handful of rows that carry a source
-- rather than the whole ledger.
CREATE INDEX IF NOT EXISTS "channel_messages_reply_source_idx"
  ON "public"."channel_messages" ("created_at")
  WHERE "reply_source" IS NOT NULL;
