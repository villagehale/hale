-- VIL-102 — RSVP tally inside a Linq group chat.
--
-- Additive (rule #9). New tables only. Nothing existing is altered or dropped.
-- Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS linq_group_rsvp_replies;
--   DROP TABLE IF EXISTS linq_group_rsvp_plans;
--
-- Follows 0179_channel_inbound_media. This ticket takes 0180.

CREATE TABLE IF NOT EXISTS "linq_group_rsvp_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"host_family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"title" text,
	"starts_at" timestamp with time zone,
	"location" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_rsvp_plans_status_check" CHECK ("status" IN ('open', 'closed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_rsvp_plans_live_chat_uniq" ON "linq_group_rsvp_plans" ("chat_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_rsvp_plans_host_idx" ON "linq_group_rsvp_plans" ("host_family_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_group_rsvp_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL REFERENCES "linq_group_rsvp_plans"("id") ON DELETE cascade,
	"household_key" text NOT NULL,
	"family_id" uuid REFERENCES "families"("id") ON DELETE set null,
	"user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"display_name" text,
	"response" text NOT NULL,
	"source" text NOT NULL,
	"verbatim" text,
	"interpretation" text,
	"calendar_permission" text,
	"calendar_event_id" uuid REFERENCES "family_events"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_rsvp_replies_response_check" CHECK ("response" IN ('yes', 'no', 'pending')),
	CONSTRAINT "linq_group_rsvp_replies_source_check" CHECK ("source" IN ('text', 'tapback')),
	CONSTRAINT "linq_group_rsvp_replies_permission_check" CHECK ("calendar_permission" IS NULL OR "calendar_permission" IN ('pending', 'granted', 'refused'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_rsvp_replies_plan_household_uniq" ON "linq_group_rsvp_replies" ("plan_id", "household_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_rsvp_replies_plan_idx" ON "linq_group_rsvp_replies" ("plan_id");--> statement-breakpoint
ALTER TABLE "linq_group_rsvp_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "linq_group_rsvp_replies" ENABLE ROW LEVEL SECURITY;
