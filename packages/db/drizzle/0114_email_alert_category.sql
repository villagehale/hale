-- A parenting email in a connected Gmail becomes one text to the parent. Additive (rule #9).
-- Its own lane and NOT 'nudge': the outbound gate COUNTS a category, so folding these in
-- would let one school notice spend a household's weekly nudge budget — and then the nudge
-- cap would read as spent by messages the nudge sweep never sent.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'email_alert';
