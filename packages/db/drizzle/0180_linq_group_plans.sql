-- VIL-441 (T14) — plan together: options posted in a household group, and each
-- person's yes / no / maybe. Additive (rule #9). Re-runnable: IF NOT EXISTS.
-- Reversible:
--   DROP TABLE IF EXISTS linq_group_plan_answers;
--   DROP TABLE IF EXISTS linq_group_plans;
--
-- Follows 0179_channel_inbound_media. One live open plan per chat. A follow-up
-- is stamped once. A non-member answer is stored and never counted as a seat.

CREATE TABLE IF NOT EXISTS "linq_group_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"chat_id" text NOT NULL,
	"topic" text NOT NULL,
	"options" jsonb NOT NULL,
	"deadline_at" timestamp with time zone,
	"followed_up_at" timestamp with time zone,
	"options_message_id" text,
	"settled_option_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_plans_status_check" CHECK ("status" IN ('open', 'settled', 'abandoned'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_plans_live_chat_uniq" ON "linq_group_plans" ("chat_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_plans_family_idx" ON "linq_group_plans" ("family_id");--> statement-breakpoint
ALTER TABLE "linq_group_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_group_plan_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL REFERENCES "linq_group_plans"("id") ON DELETE cascade,
	"phone_e164_hash" text NOT NULL,
	"user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"display_name" text,
	"seated" text NOT NULL,
	"stance" text NOT NULL,
	"option_id" text,
	"source" text NOT NULL,
	"verbatim" text NOT NULL,
	"interpretation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_plan_answers_stance_check" CHECK ("stance" IN ('yes', 'no', 'maybe')),
	CONSTRAINT "linq_group_plan_answers_source_check" CHECK ("source" IN ('text', 'tapback')),
	CONSTRAINT "linq_group_plan_answers_seated_check" CHECK ("seated" IN ('yes', 'no'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_plan_answers_live_plan_phone_uniq" ON "linq_group_plan_answers" ("plan_id","phone_e164_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_plan_answers_plan_idx" ON "linq_group_plan_answers" ("plan_id");--> statement-breakpoint
ALTER TABLE "linq_group_plan_answers" ENABLE ROW LEVEL SECURITY;
