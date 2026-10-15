-- channel_pending_asks, applied where 0167 cannot run.
--
-- 0167_channel_messages_pending_ask creates this table, but its journal `when`
-- (1781556209000) is below 0170_opt_out_read_holds (1781556210000), which production
-- had already recorded, so drizzle migrate never runs 0167 there. This file is the same
-- additive DDL with a later `when` (as 0150 did for 0144). Re-runnable: IF NOT EXISTS
-- throughout, so a database that already applied 0167 no-ops it.
--
-- Reversible:
--   DROP TABLE IF EXISTS channel_pending_asks;
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
