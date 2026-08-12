-- Delivery reliability on the inbound leg: one column and one unique index, both
-- additive. Nothing existing changes shape, default, or nullability.
--
-- WHY THE COLUMN. `handed_off_at` answers a question the table could not previously
-- answer: was this text actually handed to C1's queue? The webhook wrote the ledger row,
-- the audit row, and THEN enqueued, with no record of whether the third happened. An
-- enqueue failure after the first two committed left a row that every reader — including
-- Twilio's own retry, which found it and answered 'duplicate' with a 200 — read as a
-- message that had been received and handled. The parent's text (possibly a C3 approval
-- instrument) was swallowed permanently while the audit trail asserted otherwise.
-- "A row exists" and "the job exists" are two questions; this column is the second one's
-- own answer, and it is what the reconciler in the queue-maintenance cron re-drives from.
--
-- WHY THE UNIQUE INDEX. The duplicate guard was select-then-insert on a PLAIN index, and
-- Twilio resends when the handler exceeds its 15s budget — so the resend can arrive while
-- the first request is still executing. Both passed the SELECT, both inserted, both
-- audited, both enqueued, and C1 answered one text twice. Making the insert itself the
-- claim moves the guard from application timing into the database, where concurrency is
-- actually decided: exactly one request wins the row and is therefore the one that
-- enqueues.
--
-- PARTIAL ON direction = 'in'. Outbound rows carry provider ids too and are under no such
-- rule; scoping the index keeps it off every send Hale makes.
--
-- BEFORE APPLYING TO PRODUCTION, check for rows the race already created — the index
-- creation fails on any existing duplicate:
--   SELECT provider_message_id, count(*) FROM channel_messages
--   WHERE direction = 'in' AND provider_message_id IS NOT NULL
--   GROUP BY provider_message_id HAVING count(*) > 1;
-- A non-empty result means a real double-processed inbound: keep the earliest row per
-- sid and delete the rest (their audit rows record what happened) before creating the
-- index.
-- WHY THE BACKFILL. Every inbound row that already exists predates the column, so it
-- reads as unhanded — and the reconciler's whole job is to re-drive unhanded rows. Left
-- alone, the first cron tick after this deploys would re-answer every text in its window
-- at once. Stamping the existing rows declares the truthful thing about them: whatever
-- happened, it happened under the old code and is finished. It does mean a text the old
-- code really did swallow stays swallowed, which is the right trade — we cannot tell
-- those apart from the handled ones, and answering a stranger's day-old message is worse
-- than never answering it.
ALTER TABLE "public"."channel_messages"
  ADD COLUMN IF NOT EXISTS "handed_off_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "public"."channel_messages"
  SET "handed_off_at" = "created_at"
  WHERE "direction" = 'in' AND "handed_off_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_messages_inbound_provider_msg_uniq"
  ON "public"."channel_messages" ("provider_message_id")
  WHERE "direction" = 'in' AND "provider_message_id" IS NOT NULL;
