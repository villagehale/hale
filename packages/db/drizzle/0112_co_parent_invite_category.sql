-- VIL-355 · the co-parent invite exchange gets its own ledger lane. Additive (rule #9).
-- Folding it into 'caregiver' would make a co-parent's messages read as a disclosure to
-- somebody outside the household, which is the opposite of what happened.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'co_parent_invite';
