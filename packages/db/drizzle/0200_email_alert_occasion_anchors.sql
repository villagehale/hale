-- VIL-596: an occasion claim identifies a state CHANGE. Each claim records the instants
-- (or, with none, the matched event or the message) it was about, so the next email about
-- the same instant can ask "what was the LAST thing this thread told about it?": the same
-- occasion again is a repeat, and a return to an earlier state (on, off, on) is news.
-- anchor_keys holds KEYED indexes (HMAC-SHA256 under an HKDF subkey of APP_ENCRYPTION_KEY)
-- of connection, thread and anchor: an instant is guessable, so an unkeyed digest of one
-- would be a lookup table. No title, place or address is stored.
-- "Last" is the EMAIL's own order (received_at, Gmail's internalDate), not the claim's.
--
-- activity_bookings.source_received_at is the received time of the newest email that
-- recorded or refreshed a booking: a cancellation older than it does not close the row.
--
-- Additive (rule #9): three nullable columns and one index. Rows written before this file
-- keep NULL: claims still dedupe by their key, and bookings close as before.
-- Re-runnable: IF NOT EXISTS throughout.
-- Reversible:
--   ALTER TABLE activity_bookings DROP COLUMN IF EXISTS source_received_at;
--   DROP INDEX IF EXISTS email_alert_occasions_anchor_keys_idx;
--   ALTER TABLE email_alert_occasions DROP COLUMN IF EXISTS received_at;
--   ALTER TABLE email_alert_occasions DROP COLUMN IF EXISTS anchor_keys;
ALTER TABLE "email_alert_occasions" ADD COLUMN IF NOT EXISTS "anchor_keys" text[];--> statement-breakpoint
ALTER TABLE "email_alert_occasions" ADD COLUMN IF NOT EXISTS "received_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_alert_occasions_anchor_keys_idx" ON "email_alert_occasions" USING gin ("anchor_keys");--> statement-breakpoint
ALTER TABLE "activity_bookings" ADD COLUMN IF NOT EXISTS "source_received_at" timestamp with time zone;
