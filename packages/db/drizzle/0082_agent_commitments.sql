-- MEM-10 · the open-loops ledger — Hale's own promises, as rows. Additive only
-- (rule #9): one new enum type and one new table. Nothing existing is altered, and an
-- empty table is byte-for-byte today's behaviour (no surface reads it until a promise
-- has been written).
--
-- The two closure constraints are in the DATABASE rather than in the writer because
-- both failures are silent: a row fulfilled by nothing reads back as a kept promise
-- nobody can point at, and a cancellation with no reason is a debt quietly deleted.
-- The one shape a ledger must never be able to express is a promise that stopped
-- being owed without saying how.
DO $$ BEGIN
  CREATE TYPE "public"."agent_commitment_kind" AS ENUM('first_find', 'registration_plan');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"commitment_kind" "agent_commitment_kind" NOT NULL,
	-- The channel_messages row that carried the promise. NOT NULL is the send-time
	-- discipline: a compose that never reached a transport has no ledger row, so it
	-- cannot mint a debt.
	"created_from" text NOT NULL,
	"summary" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"fulfilled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_commitments_closure_check" CHECK (
		("fulfilled_at" IS NULL) = ("fulfilled_by" IS NULL)
		AND ("cancelled_at" IS NULL) = ("cancelled_reason" IS NULL)
		AND NOT ("fulfilled_at" IS NOT NULL AND "cancelled_at" IS NOT NULL)
	)
);--> statement-breakpoint

-- At most ONE open promise of a kind per family. This is what lets a fulfilling surface
-- close "the first-find promise for this family" without a correlation id, and it is the
-- idempotency anchor a retried webhook or a double cron tick conflicts on.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_commitments_open_kind_uniq"
	ON "agent_commitments" ("family_id", "commitment_kind")
	WHERE "fulfilled_at" IS NULL AND "cancelled_at" IS NULL;--> statement-breakpoint

-- The overdue sweep's scan: only the promises still outstanding are in the index.
CREATE INDEX IF NOT EXISTS "agent_commitments_open_due_idx"
	ON "agent_commitments" ("due_at")
	WHERE "fulfilled_at" IS NULL AND "cancelled_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_commitments_family_idx"
	ON "agent_commitments" ("family_id", "created_at");--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The
-- app connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "agent_commitments" ENABLE ROW LEVEL SECURITY;
