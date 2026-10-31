-- VIL-471 — parent-made polls in a Linq group chat, plus votes on a native
-- poll card Hale sent there (the VIL-458 stuck-group offer).
--
-- Additive (rule #9). New tables only. Nothing existing is altered or dropped.
-- Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS linq_group_poll_votes;
--   DROP TABLE IF EXISTS linq_group_polls;
--
-- 0180 to 0189 are taken by open branches; this ticket takes 0190 with its own
-- journal `when`.
--
-- A chat has one live poll at a time. A vote updates in place on
-- (poll_id, member_key) so a changed mind cannot double-count. No message text
-- is stored, only the option key.

CREATE TABLE IF NOT EXISTS "linq_group_polls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"question" text,
	"options" jsonb NOT NULL,
	"expected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_message_id" text,
	"origin" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_polls_origin_check" CHECK ("origin" IN ('parent', 'hale_offer'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_polls_live_chat_uniq" ON "linq_group_polls" ("chat_id") WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_polls_provider_message_idx" ON "linq_group_polls" ("provider_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_polls_family_idx" ON "linq_group_polls" ("family_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_group_poll_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL REFERENCES "linq_group_polls"("id") ON DELETE cascade,
	"member_key" text NOT NULL,
	"display_name" text NOT NULL,
	"user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"hale_customer" text DEFAULT 'false' NOT NULL,
	"option_key" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_poll_votes_source_check" CHECK ("source" IN ('text', 'native')),
	CONSTRAINT "linq_group_poll_votes_hale_customer_check" CHECK ("hale_customer" IN ('true', 'false'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_poll_votes_poll_member_uniq" ON "linq_group_poll_votes" ("poll_id","member_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_poll_votes_poll_idx" ON "linq_group_poll_votes" ("poll_id");--> statement-breakpoint
ALTER TABLE "linq_group_polls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "linq_group_poll_votes" ENABLE ROW LEVEL SECURITY;
