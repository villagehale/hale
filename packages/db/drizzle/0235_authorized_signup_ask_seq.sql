-- A bare yes or no answers the sign-up ask whose text reached the parent last. No clock can
-- say which that was: a turn and a sweep each carry the time they started, so a text sent
-- last can carry the earlier time, and one sweep texting two asks gives both one instant.
-- authorized_signup_ask_seq is drawn once each time a text about an ask was delivered (the
-- offer itself, a question back, a notice, a receipt), in the UPDATE that runs right after
-- the transport accepted it. last_asked_seq therefore orders asks by delivery and never ties.
-- Null: no text about the ask is known to have reached the parent (rows from before this,
-- or an offer whose text failed to send), and such an ask never takes a bare answer.
-- last_asked_at (0234) stays, only as when that happened, never as an order. A number only:
-- never a person, a message body or a link.
-- Additive (rule #9). No backfill: an ask from before this takes a bare answer again once
-- Hale's next text about it went out (a question back on words that name it, a notice, a
-- receipt). Re-runnable: IF NOT EXISTS. Reversible:
--   ALTER TABLE authorized_signup_offers DROP COLUMN IF EXISTS last_asked_seq;
--   DROP SEQUENCE IF EXISTS authorized_signup_ask_seq;
CREATE SEQUENCE IF NOT EXISTS "authorized_signup_ask_seq";--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "last_asked_seq" bigint;
