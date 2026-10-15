-- The question a general answer left open, beside the reply that left it. One new table
-- (rule #9: additive, nothing existing is altered). The lane neither reads nor writes it
-- while GENERAL_ANSWER_SEARCH_ENABLED is dark; the hourly retention sweep is its one
-- other reader.
--
-- Re-runnable: IF NOT EXISTS throughout. Reversible:
--   DROP TABLE IF EXISTS channel_pending_asks;
--
-- WHY. The off-topic lane is one text in and one out. When Hale asks "which city?" the
-- parent's "Toronto" starts a new turn with no question attached, so the ask led nowhere
-- (Sloane's finding 1 on #861). The reply that left the question open now keeps it, and
-- the parent's next text in that thread is read beside it.
--
-- WHY A TABLE OF ITS OWN, and not two columns on channel_messages (which is what this
-- file first added, before it was applied anywhere). Every insert into channel_messages
-- names every column, so with the columns there this migration had to run before any
-- code that knew of them could send a text at all. A table that only the lit lane touches
-- has no such order: a database without it sends every text as before.
--
-- WHAT IS STORED, AND WHAT IS NOT (rule #1). The DE-IDENTIFIED question: the sanitize
-- stage's rewrite with the family taken out, then a deterministic scrub of phone numbers,
-- addresses and the like. And what it was missing, in a few words. Never the parent's
-- own words, which stay where they already are (the inbound row's body), and never what
-- Hale said. Both are bounded: a longer question is not kept at all, and the two CHECKs
-- restate the bounds the schema file names (channel-pending-asks.ts).
--
-- KEYED BY THE OUTBOUND ROW, because it is a fact about the REPLY, as 0090 and 0103 are.
-- "Is it still pending" stays a question the ledger answers, the way the readiness and
-- check-in asks do: it stands while that row is Hale's last word to that parent.
--
-- IT LIVES ONLY WHILE IT IS OPEN. The next reply Hale sends that parent deletes it. The
-- hourly retention sweep deletes one that any other newer word from Hale has closed, and
-- one a year old (apps/web/lib/rights/message-retention.ts).
-- Both foreign keys cascade, which IS the erasure path: runDeletionSweep deletes the
-- family row, and the reply row takes its question with it.
CREATE TABLE IF NOT EXISTS "channel_pending_asks" (
	"channel_message_id" uuid PRIMARY KEY NOT NULL REFERENCES "channel_messages"("id") ON DELETE cascade,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"question" text NOT NULL,
	"missing" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_pending_asks_question_length_check" CHECK (char_length("question") <= 500),
	CONSTRAINT "channel_pending_asks_missing_length_check" CHECK (char_length("missing") <= 200)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_pending_asks_family_idx" ON "channel_pending_asks" ("family_id");--> statement-breakpoint
ALTER TABLE "channel_pending_asks" ENABLE ROW LEVEL SECURITY;
