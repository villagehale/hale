-- VIL-324 — one next-morning reminder for a sitting first-hello.
-- Additive only (rule #9): a nullable timestamp. follow_up_count stays the
-- same-thread incomplete-details ask; this column is the scheduled reminder's
-- at-most-once claim, so the two cannot consume each other.
--
-- Claimed BEFORE the send. A second hourly tick finds the timestamp set and
-- stays quiet. NULL = not yet reminded.
ALTER TABLE "sms_intake_sessions"
  ADD COLUMN IF NOT EXISTS "sitting_reminder_sent_at" timestamp with time zone;
