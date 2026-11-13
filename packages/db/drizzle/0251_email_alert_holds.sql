-- VIL-569 / 0251: a quiet-hours hold on an email alert is a debt, not a drop. The Gmail cursor
-- moves past a message the moment the sweep reads it, so the hold receipt alone left
-- nothing to re-offer: an email at 07:50 was never mentioned, one at 08:05 was. One row
-- per held message, pointing at its suppressed_quiet_hours receipt; the sweep re-reads the
-- message and re-runs the alert once the gate allows it, or closes the row stale.
--
-- It holds the Gmail message id only, never anything read from the email (rule #1).
-- Erasure is the cascade from the receipt row (and so from the family).
--
-- Additive (rule #9). Re-runnable: IF NOT EXISTS throughout. Reversible:
--   DROP TABLE IF EXISTS email_alert_holds;
CREATE TABLE IF NOT EXISTS "email_alert_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_message_id" uuid NOT NULL REFERENCES "channel_messages"("id") ON DELETE cascade,
	"integration_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"held_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "email_alert_holds_closed_check" CHECK (("closed_at" IS NULL) = ("outcome" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_alert_holds_message_uniq" ON "email_alert_holds" ("integration_id","message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_alert_holds_open_idx" ON "email_alert_holds" ("integration_id","held_at") WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_alert_holds_channel_message_idx" ON "email_alert_holds" ("channel_message_id");--> statement-breakpoint
ALTER TABLE "email_alert_holds" ENABLE ROW LEVEL SECURITY;
