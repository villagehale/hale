-- VIL-662 · a matched team-schedule change (coach / league / TeamSnap email)
-- waiting on a calendar_move or calendar_cancel. Additive (rule #9): a new
-- table, nothing dropped. Re-runnable: IF NOT EXISTS on the table and indexes.
--
-- `gmail_message_id` is a pointer for read_email (VIL-619), never a body.
-- `new_location` is the scrubbed place only — no link, no phone.
-- Effects (driver text, reminder re-anchor) stamp `effects_applied_at` once
-- the action has executed.

CREATE TABLE IF NOT EXISTS "team_schedule_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL,
  "action_id" uuid NOT NULL,
  "family_event_id" uuid NOT NULL,
  "gmail_message_id" text NOT NULL,
  "change_kind" text NOT NULL,
  "original_starts_at" timestamp with time zone NOT NULL,
  "time_zone" text NOT NULL,
  "new_starts_at" timestamp with time zone,
  "new_ends_at" timestamp with time zone,
  "new_location" text,
  "effects_applied_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "team_schedule_changes"
    ADD CONSTRAINT "team_schedule_changes_family_id_families_id_fk"
    FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "team_schedule_changes"
    ADD CONSTRAINT "team_schedule_changes_action_id_actions_id_fk"
    FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "team_schedule_changes"
    ADD CONSTRAINT "team_schedule_changes_family_event_id_family_events_id_fk"
    FOREIGN KEY ("family_event_id") REFERENCES "public"."family_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_schedule_changes_action_uniq" ON "team_schedule_changes" USING btree ("action_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_schedule_changes_family_idx" ON "team_schedule_changes" USING btree ("family_id");
