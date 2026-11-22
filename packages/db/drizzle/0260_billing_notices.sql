CREATE TABLE IF NOT EXISTS "billing_notices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "parent_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "lane" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "drop_reason" text,
  "facts" jsonb NOT NULL,
  "last_event_at" timestamp with time zone NOT NULL,
  "next_try_at" timestamp with time zone NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "channel_message_id" uuid REFERENCES "channel_messages"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_notices_lane_check" CHECK ("lane" IN ('payment', 'plan_change')),
  CONSTRAINT "billing_notices_status_check" CHECK ("status" IN ('open', 'sending', 'sent', 'dropped'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_notices_one_open_uniq"
  ON "billing_notices" ("family_id", "lane") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_notices_due_idx"
  ON "billing_notices" ("next_try_at") WHERE "status" IN ('open', 'sending');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_notices_recipient_idx"
  ON "billing_notices" ("parent_user_id");--> statement-breakpoint
ALTER TABLE "billing_notices" ENABLE ROW LEVEL SECURITY;
