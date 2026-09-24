-- In-group co-parent onboarding step, and per-parent busy blocks.
--
-- Additive (rule #9). Reversible:
--   DROP TABLE IF EXISTS parent_calendar_blocks;
--   DROP TABLE IF EXISTS linq_group_onboarding;
-- Nothing existing is altered. Re-runnable: IF NOT EXISTS throughout.
--
-- linq_group_onboarding is the second parent's ladder inside a claimed Linq
-- group: name, then their own calendar link, then their own Gmail link.
-- It does not store children or a postal code.
--
-- parent_calendar_blocks is free/busy memory. A non-kid row cannot hold a
-- title (CHECK). Kid rows may. Deleting the integration takes the blocks.
CREATE TABLE IF NOT EXISTS "linq_group_onboarding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"provider_chat_id" text NOT NULL,
	"step" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_onboarding_user_uniq" ON "linq_group_onboarding" ("user_id");--> statement-breakpoint
ALTER TABLE "linq_group_onboarding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "parent_calendar_blocks" (
	"integration_id" uuid NOT NULL REFERENCES "integrations"("id") ON DELETE cascade,
	"event_id" text NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"all_day" boolean DEFAULT false NOT NULL,
	"kid_related" boolean NOT NULL,
	"title" text,
	"recurring_event_id" text,
	"status" text NOT NULL,
	"updated_stamp" text NOT NULL,
	"announced_at" timestamp with time zone,
	"followup_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parent_calendar_blocks_pkey" PRIMARY KEY("integration_id","event_id"),
	CONSTRAINT "parent_calendar_blocks_title_kid_only" CHECK ("kid_related" OR "title" IS NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parent_calendar_blocks_family_start_idx" ON "parent_calendar_blocks" ("family_id","start_at");--> statement-breakpoint
ALTER TABLE "parent_calendar_blocks" ENABLE ROW LEVEL SECURITY;
