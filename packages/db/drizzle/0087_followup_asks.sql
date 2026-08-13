-- The follow-up ask — Hale checks back after an introduction it made or an activity it
-- placed. Additive only (rule #9): one enum value. Nothing is dropped and no existing
-- value changes meaning.
--
-- No row uses the new value in this transaction, so ADD VALUE is safe on its own (the
-- 0072 / 0083 / 0086 precedent).
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'followup';
