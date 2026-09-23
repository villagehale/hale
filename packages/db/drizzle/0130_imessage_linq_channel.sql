-- iMessage via Linq (VIL-335) — a blue-bubble turn is a delivery leg of its own.
--
-- The continuity law is unchanged: the sender handle is an E.164, and that number is
-- the person the SMS blind index already enrolled. What must not be folded together
-- is the PIPE. A ledger that records an iMessage as 'sms' is wrong in a PIPEDA
-- right-to-access read, and it would send the answer back through Twilio.
--
-- provider_chat_id is the Linq chat the reply returns to. Null on every other pipe.
-- Additive only (rule #9): one enum value, one nullable column. Nothing is dropped
-- and no existing value changes meaning. No row uses the new value in this
-- transaction, so ADD VALUE is safe beside the column add (the 0091 precedent).
ALTER TYPE "public"."channel_message_channel" ADD VALUE IF NOT EXISTS 'imessage';--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN IF NOT EXISTS "provider_chat_id" text;
