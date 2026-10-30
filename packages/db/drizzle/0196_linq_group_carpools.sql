-- VIL-445 (T16) — carpool plans read from a group chat, plus the night-before
-- reminder hook. Additive (rule #9). A new table only.
-- Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS linq_group_carpools;
--
-- Who is driving is stored only after someone in the chat said it. There is no
-- rota. A swap updates the live row. Cancel sets cancelled_at and keeps the row
-- so a later cron cannot send. The phone of a driver is never stored here.

CREATE TABLE IF NOT EXISTS "linq_group_carpools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"plan_key" text NOT NULL,
	"event_label" text,
	"pickup_at" timestamp with time zone,
	"pickup_place" text,
	"kids" text,
	"driver_name" text,
	"driver_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"driver_hale_customer" text DEFAULT 'false' NOT NULL,
	"driver_timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"asked_for_driver_at" timestamp with time zone,
	"ask_message_id" text,
	"reminder_fire_at" timestamp with time zone,
	"reminder_status" text DEFAULT 'unscheduled' NOT NULL,
	"reminder_group_sent_at" timestamp with time zone,
	"reminder_driver_sent_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_carpools_status_check" CHECK ("status" IN ('open', 'assigned', 'cancelled')),
	CONSTRAINT "linq_group_carpools_reminder_status_check" CHECK ("reminder_status" IN ('unscheduled', 'pending', 'sent', 'held_quiet', 'skipped_cancelled', 'skipped_no_driver', 'suppressed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_carpools_live_chat_plan_uniq" ON "linq_group_carpools" ("chat_id","plan_key") WHERE "cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_carpools_due_idx" ON "linq_group_carpools" ("reminder_status","reminder_fire_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_carpools_family_idx" ON "linq_group_carpools" ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_carpools_ask_message_idx" ON "linq_group_carpools" ("ask_message_id");--> statement-breakpoint
ALTER TABLE "linq_group_carpools" ENABLE ROW LEVEL SECURITY;
