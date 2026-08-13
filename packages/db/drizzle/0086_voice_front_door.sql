-- The voice front door — a caller to Hale's number is answered and handed to text.
-- Additive only (rule #9): one enum value. Nothing is dropped and no existing value
-- changes meaning.
--
-- No row uses the new value in this transaction, so ADD VALUE is safe on its own (the
-- 0072 / 0083 precedent).
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'voice';
