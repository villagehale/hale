-- VIL-503 — one household's consent before a group-plan calendar copy.
--
-- Additive (rule #9). New table only. Nothing existing is altered or dropped.
-- Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS linq_group_plan_calendar_consents;
--
-- Numbered 0200. 0198 and 0199 belong to other branches.
--
-- A household that said yes to a tracked plan gets one row per plan. The
-- calendar copy is written only after that row is `written`, and only for
-- this family_id. Another household's row is a different key.

CREATE TABLE IF NOT EXISTS "linq_group_plan_calendar_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL REFERENCES "linq_group_plans"("id") ON DELETE cascade,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"member_key" text NOT NULL,
	"display_name" text NOT NULL,
	"household_label" text,
	"status" text NOT NULL,
	"ask_provider_message_id" text,
	"family_event_id" uuid REFERENCES "family_events"("id") ON DELETE set null,
	"asked_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_plan_calendar_consents_status_check" CHECK ("status" IN ('asked', 'declined', 'written'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_plan_calendar_consents_plan_family_uniq" ON "linq_group_plan_calendar_consents" ("plan_id", "family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_plan_calendar_consents_family_idx" ON "linq_group_plan_calendar_consents" ("family_id");--> statement-breakpoint
ALTER TABLE "linq_group_plan_calendar_consents" ENABLE ROW LEVEL SECURITY;
