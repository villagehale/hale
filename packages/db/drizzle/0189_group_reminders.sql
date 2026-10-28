-- VIL-448 (T26) — "remind me" from anyone in a family's Linq group.
--
-- One row per reminder a group member asked for. Additive only: a new table, nothing
-- existing is altered. People are held by the group seat's blind index, never by number;
-- `what` (the member's own words) is cleared when the row closes. RLS on, like every
-- table since 2026-08-11.
--
-- Reversible:
--   DROP TABLE IF EXISTS group_reminders;
CREATE TABLE IF NOT EXISTS "group_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"chat_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"asked_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"asked_by_phone_hash" text NOT NULL,
	"for_kind" text NOT NULL,
	"for_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"for_phone_hash" text,
	"for_name" text,
	"what" text,
	"language" text DEFAULT 'en' NOT NULL,
	"asked_for_at" timestamp with time zone NOT NULL,
	"deliver_at" timestamp with time zone NOT NULL,
	"delivery" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "group_reminders_status_check" CHECK ("status" in ('pending', 'scheduled', 'sending', 'sent', 'queued', 'cancelled', 'dropped', 'failed')),
	CONSTRAINT "group_reminders_for_kind_check" CHECK ("for_kind" in ('sender', 'person', 'everyone')),
	CONSTRAINT "group_reminders_delivery_check" CHECK ("delivery" in ('group', 'direct')),
	CONSTRAINT "group_reminders_direct_sender_check" CHECK ("delivery" = 'group' OR "for_kind" = 'sender'),
	CONSTRAINT "group_reminders_what_length_check" CHECK ("what" IS NULL OR char_length("what") <= 300)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "group_reminders_source_uniq" ON "group_reminders" ("source_message_id", "ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_reminders_due_idx" ON "group_reminders" ("status", "deliver_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_reminders_chat_idx" ON "group_reminders" ("chat_id", "status");--> statement-breakpoint
ALTER TABLE "group_reminders" ENABLE ROW LEVEL SECURITY;
