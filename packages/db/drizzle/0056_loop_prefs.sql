-- F11 · The Sunday Loop (VIL-216 · A5): per-parent loop preferences. Additive
-- only (rule #9). This is a NEW store — the existing notification_prefs (two push
-- booleans) and email_opt_outs (CASL digest opt-out) are UNTOUCHED; live crons
-- depend on them, and the loop taxonomy here does not map onto those old streams.
--
-- One row per parent (co-parents independent). Row ABSENCE is the documented
-- default (loop_channel email, all categories on, quiet 21:30-07:30, urgent
-- bypass on, weekly send 19:30, name level generic). Quiet hours + the weekly
-- send time are wall-clock local `time` values interpreted in the parent's own
-- users.timezone (the send DAY composes with users.week_start_day — no new
-- timezone source). child_name_level defaults to the most private (rule #1) and
-- composes with the deterministic teen age gate. Cascades on the user so a
-- deleted account leaves nothing behind (rule #1).
--
-- Journal slot: 0056 is pre-assigned to VIL-216; 0054/0055 are reserved for
-- VIL-217 (weekly-plan composer). If VIL-217 has not merged when this lands, the
-- merge order must place it first so the journal stays contiguous.
CREATE TYPE "public"."loop_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."child_name_level" AS ENUM('first_name', 'relation', 'generic');--> statement-breakpoint
CREATE TABLE "loop_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"loop_channel" "public"."loop_channel" DEFAULT 'email' NOT NULL,
	"cat_weekly_plan" boolean DEFAULT true NOT NULL,
	"cat_reminder" boolean DEFAULT true NOT NULL,
	"cat_approval" boolean DEFAULT true NOT NULL,
	"cat_alert" boolean DEFAULT true NOT NULL,
	"quiet_hours_start" time DEFAULT '21:30:00' NOT NULL,
	"quiet_hours_end" time DEFAULT '07:30:00' NOT NULL,
	"urgent_bypass_quiet_hours" boolean DEFAULT true NOT NULL,
	"weekly_plan_send_time" time DEFAULT '19:30:00' NOT NULL,
	"child_name_level" "public"."child_name_level" DEFAULT 'generic' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loop_prefs" ADD CONSTRAINT "loop_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0040/0041.
-- The app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "loop_prefs" ENABLE ROW LEVEL SECURITY;
