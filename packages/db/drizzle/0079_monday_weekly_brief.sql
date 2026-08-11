ALTER TABLE "loop_prefs" ALTER COLUMN "weekly_plan_send_time" SET DEFAULT '07:00:00';
--> statement-breakpoint
UPDATE "loop_prefs" SET "weekly_plan_send_time" = '07:00:00' WHERE "weekly_plan_send_time" = '19:30:00';
