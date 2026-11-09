-- VIL-442 (T15) — RSVP tracking for any plan in a Linq group chat.
--
-- Additive (rule #9). New tables only. Nothing existing is altered or dropped.
-- Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS linq_group_plan_followups;
--   DROP TABLE IF EXISTS linq_group_plan_expected;
--   DROP TABLE IF EXISTS linq_group_plan_rsvps;
--   DROP TABLE IF EXISTS linq_group_plans;
--
-- Follows 0179_channel_inbound_media. This ticket takes 0180.
--
-- A group may track one live plan at a time. RSVPs update in place on
-- (plan_id, member_key) so an edit cannot double-count. Follow-up sends are
-- claimed before they go out.

CREATE TABLE IF NOT EXISTS "linq_group_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone,
	"location" text,
	"rsvp_deadline_at" timestamp with time zone,
	"expected_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_plans_expected_count_check" CHECK ("expected_count" >= 0 AND "expected_count" <= 80)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_plans_live_chat_uniq" ON "linq_group_plans" ("chat_id") WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_plans_family_idx" ON "linq_group_plans" ("family_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_group_plan_rsvps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL REFERENCES "linq_group_plans"("id") ON DELETE cascade,
	"member_key" text NOT NULL,
	"display_name" text NOT NULL,
	"household_label" text,
	"user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"hale_customer" text DEFAULT 'false' NOT NULL,
	"response" text NOT NULL,
	"headcount" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"covers_keys" text DEFAULT '[]' NOT NULL,
	"verbatim" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_plan_rsvps_response_check" CHECK ("response" IN ('yes', 'no', 'maybe')),
	CONSTRAINT "linq_group_plan_rsvps_source_check" CHECK ("source" IN ('text', 'tapback', 'on_behalf')),
	CONSTRAINT "linq_group_plan_rsvps_hale_customer_check" CHECK ("hale_customer" IN ('true', 'false')),
	CONSTRAINT "linq_group_plan_rsvps_headcount_check" CHECK ("headcount" >= 1 AND "headcount" <= 20)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_plan_rsvps_plan_member_uniq" ON "linq_group_plan_rsvps" ("plan_id","member_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_plan_rsvps_plan_idx" ON "linq_group_plan_rsvps" ("plan_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_group_plan_expected" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL REFERENCES "linq_group_plans"("id") ON DELETE cascade,
	"member_key" text NOT NULL,
	"display_name" text NOT NULL,
	"user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"hale_customer" text DEFAULT 'false' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_plan_expected_hale_customer_check" CHECK ("hale_customer" IN ('true', 'false'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_plan_expected_plan_member_uniq" ON "linq_group_plan_expected" ("plan_id","member_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_plan_expected_plan_idx" ON "linq_group_plan_expected" ("plan_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_group_plan_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL REFERENCES "linq_group_plans"("id") ON DELETE cascade,
	"wave" integer DEFAULT 1 NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_plan_followups_wave_check" CHECK ("wave" >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_plan_followups_plan_wave_uniq" ON "linq_group_plan_followups" ("plan_id","wave");--> statement-breakpoint
ALTER TABLE "linq_group_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "linq_group_plan_rsvps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "linq_group_plan_expected" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "linq_group_plan_followups" ENABLE ROW LEVEL SECURITY;
