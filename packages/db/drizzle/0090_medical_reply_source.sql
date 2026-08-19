-- The medical-symptom lane's OUTCOME, on the reply it sent. One additive nullable
-- column, one check, one partial index. Nothing existing changes shape or default.
--
-- WHY. That lane answers rather than deflecting — a web-grounded, coarse-age-aware reply
-- with its own triage — and its failure mode is the fixed 811/911 line, taken only after
-- a live attempt and a retry both failed. Which of the two a parent got existed solely as
-- an in-memory `replySource` on the way to the transport, so the founder scorecard's
-- Safety row could not count fallbacks and carried "medical-answer fallbacks are not
-- instrumented" on every grade, including its 10s. A safety row that says "clean" on
-- trust is the one row that must never do that.
--
-- WHY ON THE OUTBOUND ROW. It is a fact about the REPLY, not about the question: the
-- inbound row is deliberately left unstamped by this lane (unmet_lane/unmet_category stay
-- null, because a question Hale answered is not an unmet intent, and stamping it would
-- corrupt the weekly demand count). The outbound row already exists, is already
-- family-scoped, already cascades on family deletion, and is already the table the weekly
-- digest reads a 7-day window out of.
--
-- WHY ITS OWN COLUMN RATHER THAN A GENERAL `reply_source`. Only this lane writes here,
-- and that is the point: 'fixed' as a shared vocabulary would be indistinguishable from
-- the two fixed doors (safety, provider access) and from the general answer's safety
-- fallback, so the count the Safety row needs could not be taken. A present value means
-- "this reply was a medical-symptom answer" — one question, one reader.
--
-- NO TEXT, NO PII. Two values, enumerated in the database rather than only in TypeScript
-- so no future writer, backfill or manual UPDATE can land a sentence here; `body` stays
-- null on outbound rows under the existing convention. Rule #1.
ALTER TABLE "public"."channel_messages"
  ADD COLUMN IF NOT EXISTS "medical_reply_source" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "public"."channel_messages"
    ADD CONSTRAINT "channel_messages_medical_reply_source_check"
    CHECK ("medical_reply_source" IS NULL OR "medical_reply_source" IN (
      'web_grounded', 'fixed'
    ));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- The digest's weekly window over medical answers. Partial, like the unmet index beside
-- it, so it covers the handful of rows that carry an outcome rather than the whole ledger.
CREATE INDEX IF NOT EXISTS "channel_messages_medical_idx"
  ON "public"."channel_messages" ("created_at")
  WHERE "medical_reply_source" IS NOT NULL;
