-- VIL-223 (D1) — event_reminders: the materialized reminder ledger. Additive only (rule #9).
--
-- reminder_status: the lifecycle of a reminder row — 'scheduled' (materialized),
-- 'sent', 'suppressed' (a don't-send rule fired; reason in suppress_reason),
-- 'cancelled' (the event was soft-deleted — never fires, the trust invariant), 'stale'
-- (the event moved; this row is for the old fire time).
--
-- event_reminders: one row per (event, offset, parent) over a PLACED family_events row.
-- Materialized (not computed-at-send) so cancellations are explicit + auditable and
-- same-evening reminders are batchable. The hourly scheduler converges this ledger to
-- the set derived from live family_events (a move re-anchors fire_at via the unique
-- (event_ref, fire_offset, parent_user_id); a soft-delete flips rows to 'cancelled'),
-- and every send is re-gated on a fresh read of the live event.
--
-- The unique (event_ref, fire_offset, parent_user_id) is the convergence upsert anchor
-- AND the per-(event,offset,parent) dedupe (A2 adds the channel suffix at dispatch).
-- Column is `fire_offset` (not `offset`, a SQL reserved word); it stores the ISO-8601
-- duration ('-P1D' | '-PT1H') so the offset set stays extensible.
--
-- family_events.sensitive: privacy-sensitive (health) flag, set by the calendar_add
-- executor from the week_plan item's privacySensitive. The reminder templates read it
-- to genericize the copy for EVERYONE ("a checkup", never the detail), independent of
-- the teen age gate. Additive; existing placement rows default false (pre-signal).
--
-- Slot note: file 0063 (next after 0062_calendar_placements); the journal is 1:1 with
-- the files, which is what the consistency gate checks.
CREATE TYPE "public"."reminder_status" AS ENUM('scheduled', 'sent', 'suppressed', 'cancelled', 'stale');--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN "sensitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "event_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"event_ref" uuid NOT NULL,
	"parent_user_id" uuid NOT NULL,
	"fire_offset" text NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"status" "reminder_status" DEFAULT 'scheduled' NOT NULL,
	"suppress_reason" text,
	"channel_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_reminders" ADD CONSTRAINT "event_reminders_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reminders" ADD CONSTRAINT "event_reminders_event_ref_family_events_id_fk" FOREIGN KEY ("event_ref") REFERENCES "public"."family_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reminders" ADD CONSTRAINT "event_reminders_parent_user_id_users_id_fk" FOREIGN KEY ("parent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reminders" ADD CONSTRAINT "event_reminders_channel_message_id_channel_messages_id_fk" FOREIGN KEY ("channel_message_id") REFERENCES "public"."channel_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_reminders_event_offset_parent_uniq" ON "event_reminders" USING btree ("event_ref","fire_offset","parent_user_id");--> statement-breakpoint
CREATE INDEX "event_reminders_due_idx" ON "event_reminders" USING btree ("status","fire_at");
--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as every table.
-- The app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "event_reminders" ENABLE ROW LEVEL SECURITY;
