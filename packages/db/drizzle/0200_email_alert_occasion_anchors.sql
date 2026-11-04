-- VIL-596: an occasion claim identifies a state CHANGE. Each claim records the instants
-- (or, with none, the matched event or the message) it was about, as digests scoped to
-- the connection and thread, so the next email about the same instant can ask "what was
-- the LAST thing this thread told about it?": the same occasion again is a repeat, and a
-- return to an earlier state (on, off, on) is news. "Last" is the EMAIL's own order
-- (received_at, Gmail's internalDate), not the claim's: a sweep reads newest first, so an
-- older email can be claimed after a newer one. No title, place or address is stored.
--
-- Additive (rule #9): two nullable columns and one index. Rows written before this file
-- keep NULL and still dedupe by their key. Re-runnable: IF NOT EXISTS throughout.
-- Reversible:
--   DROP INDEX IF EXISTS email_alert_occasions_anchor_keys_idx;
--   ALTER TABLE email_alert_occasions DROP COLUMN IF EXISTS received_at;
--   ALTER TABLE email_alert_occasions DROP COLUMN IF EXISTS anchor_keys;
ALTER TABLE "email_alert_occasions" ADD COLUMN IF NOT EXISTS "anchor_keys" text[];--> statement-breakpoint
ALTER TABLE "email_alert_occasions" ADD COLUMN IF NOT EXISTS "received_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_alert_occasions_anchor_keys_idx" ON "email_alert_occasions" USING gin ("anchor_keys");
