-- A new, moved or cancelled event on a connected Google Calendar becomes one text to the
-- parent. Additive (rule #9). Its own lane and NOT 'email_alert': the outbound gate COUNTS
-- a category, so sharing one would let a busy September calendar spend the inbox's budget
-- — and the inbox cap would then read as spent by messages the mailbox never produced.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'calendar_alert';
