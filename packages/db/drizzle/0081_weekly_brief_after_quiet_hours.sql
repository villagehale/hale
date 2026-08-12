-- Launch-day review P0 (2026-08-11): the Monday-brief retime (0079) set the send
-- default to 07:00 — INSIDE the default quiet-hours window, which ends 07:30. The
-- outbound gate would have suppressed every default family's weekly brief forever.
-- The brief now defaults to 08:00, after the default quiet window closes.
ALTER TABLE "loop_prefs" ALTER COLUMN "weekly_plan_send_time" SET DEFAULT '08:00:00';
--> statement-breakpoint
UPDATE "loop_prefs" SET "weekly_plan_send_time" = '08:00:00' WHERE "weekly_plan_send_time" = '07:00:00';
