-- VIL-382 · co-parent duty asks in the Linq group. Additive (rule #9).
-- Its own category rather than 'nudge' or 'calendar_alert': the outbound gate
-- counts a category, and a Sunday overview must not spend the weekly nudge,
-- nor a night-before confirmation the calendar's three-a-day.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'duty_ask';
