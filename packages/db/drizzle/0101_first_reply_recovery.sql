-- VIL-332 — same-day first-hello recovery for an inbound that minted a
-- session + SID and then left no outbound. Additive only (rule #9).
--
-- Claimed BEFORE the send. A second hourly tick finds the timestamp set and
-- stays quiet. NULL = not yet recovered. Deliberately not sitting_reminder_sent_at:
-- that column is the next-morning Still here line.
ALTER TABLE "sms_intake_sessions"
  ADD COLUMN IF NOT EXISTS "first_reply_recovered_at" timestamp with time zone;
