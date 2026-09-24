-- Decisions made in a 1:1 thread, waiting for one group sync bubble.
--
-- Additive (rule #9). Reversible:
--   DROP TABLE IF EXISTS group_decision_sync;
-- Nothing existing is altered. Re-runnable: IF NOT EXISTS throughout.
--
-- A row is a template slot (picked or passed), never a mailbox subject.
-- The flush sends one bubble after the 1:1 has been quiet, then stamps
-- flushed_at. Day and time exist only on a pick.
CREATE TABLE IF NOT EXISTS "group_decision_sync" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"origin_chat_id" text,
	"decision" text NOT NULL,
	"activity" text NOT NULL,
	"kid" text NOT NULL,
	"day" text,
	"time" text,
	"flush_after" timestamp with time zone NOT NULL,
	"flushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_decision_sync_decision_chk" CHECK ("decision" IN ('picked', 'passed')),
	CONSTRAINT "group_decision_sync_slots_chk" CHECK (
		("decision" = 'picked' AND "day" IS NOT NULL AND "time" IS NOT NULL)
		OR ("decision" = 'passed' AND "day" IS NULL AND "time" IS NULL)
	)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_decision_sync_family_flush_idx" ON "group_decision_sync" ("family_id", "flushed_at", "flush_after");--> statement-breakpoint
ALTER TABLE "group_decision_sync" ENABLE ROW LEVEL SECURITY;
