-- VIL-717 · the time Hale told a parent to expect an answer, one row per slow 1:1 ask.
-- A sweep on the scheduled drain reads the rows that came due and, when the reply to that
-- text never landed, sends one short note. No words and no phone number are stored: the
-- task is a closed category and the rest is ids and times.
-- Additive (rule #9). New table only. Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS ack_promises;

CREATE TABLE IF NOT EXISTS "ack_promises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"inbound_channel_message_id" uuid NOT NULL REFERENCES "channel_messages"("id") ON DELETE cascade,
	"ack_channel_message_id" uuid NOT NULL REFERENCES "channel_messages"("id") ON DELETE cascade,
	"task" text NOT NULL,
	"channel" text NOT NULL,
	"provider_chat_id" text,
	"reply_to_message_id" text,
	"language" text,
	"asked_at" timestamp with time zone NOT NULL,
	"promised_minutes" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"held_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"outcome" text,
	"note_channel_message_id" uuid REFERENCES "channel_messages"("id") ON DELETE set null,
	CONSTRAINT "ack_promises_task_check" CHECK ("task" IN ('registration', 'research', 'find')),
	CONSTRAINT "ack_promises_channel_check" CHECK ("channel" IN ('sms', 'imessage')),
	CONSTRAINT "ack_promises_minutes_check" CHECK ("promised_minutes" > 0),
	CONSTRAINT "ack_promises_outcome_check" CHECK (
		("outcome" IS NULL) = ("settled_at" IS NULL)
		AND ("outcome" IS NULL OR "outcome" IN ('answered', 'sent', 'lane_off', 'stale', 'held', 'unwritten', 'send_failed'))
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ack_promises_inbound_uniq" ON "ack_promises" ("inbound_channel_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ack_promises_open_due_idx" ON "ack_promises" ("due_at") WHERE "claimed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ack_promises_family_idx" ON "ack_promises" ("family_id", "created_at");--> statement-breakpoint
ALTER TABLE "ack_promises" ENABLE ROW LEVEL SECURITY;
