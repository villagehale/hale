-- VIL-335 — household iMessage group, one-shot contact card, poll option ids.
--
-- Additive only (rule #9). Nothing is dropped and no existing value changes
-- meaning. Re-runnable: every statement is IF NOT EXISTS.
--
-- linq_group_chat_id is the durable home of the co-parent group. The reply
-- still returns to the chat the inbound named; this column stops a second
-- create from opening a second group for the same household.
--
-- linq_contact_card_shared_at is the one-shot guard. Null means the Name and
-- Photo card has not been pushed into that parent's 1:1 chat.
--
-- linq_poll_options maps a vote webhook's option id back to the label Hale
-- offered, so the vote can enter the same router a text would.
ALTER TABLE "families" ADD COLUMN IF NOT EXISTS "linq_group_chat_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "families_linq_group_chat_id_uniq" ON "families" ("linq_group_chat_id") WHERE "linq_group_chat_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "parent_channels" ADD COLUMN IF NOT EXISTS "linq_contact_card_shared_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_poll_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"provider_chat_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"option_id" text NOT NULL,
	"option_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_poll_options_option_id_uniq" ON "linq_poll_options" ("option_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_poll_options_message_idx" ON "linq_poll_options" ("provider_message_id");
