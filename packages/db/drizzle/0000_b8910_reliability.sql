-- B8 / B9 / B10 reliability migration. ADDITIVE ONLY (hard rule #9): adds new
-- enum values, one nullable column, and one new table. No drops, no type
-- changes, no narrowing. Safe to apply to a populated production database.

-- B10: stage checkpoints. Two new pipeline-progress statuses between
-- `classified` and `routed`. ALTER TYPE ... ADD VALUE is non-destructive.
ALTER TYPE "event_status" ADD VALUE IF NOT EXISTS 'drafted' AFTER 'classified';
--> statement-breakpoint
ALTER TYPE "event_status" ADD VALUE IF NOT EXISTS 'reviewed' AFTER 'drafted';
--> statement-breakpoint

-- B10: persist the classifier's routing suggestion so a crash-resume can route
-- without re-running the (billable) classifier. Nullable — existing rows are
-- untouched and read back as NULL.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "classifier_suggestion" jsonb;
--> statement-breakpoint

-- B9: outbound-send idempotency claim table. The unique constraint on
-- action_id is the "exactly once" gate the Executor claims before any external
-- send; a redelivery's claim insert conflicts and the send is skipped.
CREATE TABLE IF NOT EXISTS "outbound_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"provider_message_id" text
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_action_id_actions_id_fk"
		FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outbound_sends_action_idx" ON "outbound_sends" ("action_id");
