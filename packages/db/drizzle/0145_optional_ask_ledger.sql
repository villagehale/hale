-- VIL-392 — shared optional-ask ledger (cold start + duty_ask).
-- Additive (rule #9). Reversible:
--   DROP TABLE IF EXISTS optional_ask_ledger;
-- Re-runnable: IF NOT EXISTS. Nothing existing is altered.

CREATE TABLE IF NOT EXISTS "optional_ask_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "send_class" text NOT NULL,
  "ask_key" text NOT NULL,
  "outcome" text NOT NULL,
  "local_day" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "optional_ask_ledger_send_class_chk"
    CHECK ("send_class" IN ('duty_ask', 'logistics', 'names', 'calendar', 'email')),
  CONSTRAINT "optional_ask_ledger_outcome_chk"
    CHECK ("outcome" IN ('sent', 'declined'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "optional_ask_ledger_family_idx"
  ON "optional_ask_ledger" ("family_id", "created_at");--> statement-breakpoint
ALTER TABLE "optional_ask_ledger" ENABLE ROW LEVEL SECURITY;
