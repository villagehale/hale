-- VIL-561: one occasion in one Gmail thread is told once. The email alert's channel row
-- keeps its per-message dedupe key, because that key is also how a parent's "not mine"
-- finds the Gmail message the text was about (kid-relevance/untrack.ts). The occasion
-- claim is this table: one row per (connection, thread, occasion) key, pointing at the
-- alert row that told it. The key is a digest; it carries no title, place or address.
--
-- A table of its own, not a column on channel_messages: every insert into that table
-- names every column, so a column there would have to exist before any code that knew of
-- it could send a text at all. Only the email alert lane reads or writes this table.
-- Erasure is the cascade from the alert row (and so from the family).
--
-- Re-runnable: IF NOT EXISTS throughout. Reversible:
--   DROP TABLE IF EXISTS email_alert_occasions;
CREATE TABLE IF NOT EXISTS "email_alert_occasions" (
	"occasion_key" text PRIMARY KEY NOT NULL,
	"channel_message_id" uuid NOT NULL REFERENCES "channel_messages"("id") ON DELETE cascade,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_alert_occasions_channel_message_idx" ON "email_alert_occasions" ("channel_message_id");--> statement-breakpoint
ALTER TABLE "email_alert_occasions" ENABLE ROW LEVEL SECURITY;
