-- VIL-239 (M4 · the 48-hour proactive nudge) — two additive enum values, nothing else.
-- Additive only (rule #9): existing values are untouched, and ADD VALUE does not use
-- the new value in this transaction, so it is safe (same shape as 0070).
--
-- 'nudge' is a channel_messages category of its own rather than a reuse of 'reminder'
-- or 'alert', because the F14 outbound gate's frequency cap COUNTS this category: a
-- shared category would let a D1 event reminder consume a family's weekly nudge budget
-- (and a nudge consume the reminder budget), which is a correctness bug, not a taxonomy
-- preference.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'nudge';--> statement-breakpoint
ALTER TYPE "public"."agent_name" ADD VALUE IF NOT EXISTS 'nudge-voice';
