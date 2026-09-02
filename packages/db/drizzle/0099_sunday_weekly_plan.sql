-- VIL-319 / F11: pin weekly_plan send to Sunday so the wire matches the site
-- (PR 549). users.week_start_day is 0=Sunday, 1=Monday — the same convention as
-- localParts / Date.getUTCDay(), never 7. weeklyPlanWeekday is identity, so the
-- column default IS the send weekday. 1 was the product default (Monday 08:00),
-- not a chosen Monday.
--
-- Additive (rule #9): SET DEFAULT only. Existing rows that stored 1 stay Monday.
-- LOOP_SEND_ENABLED stays off.
ALTER TABLE "users" ALTER COLUMN "week_start_day" SET DEFAULT 0;
