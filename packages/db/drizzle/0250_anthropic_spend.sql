-- Per-call Anthropic spend ledger for the prepaid-credit #ops alert.
-- No family_id: ops only. RLS on so PostgREST cannot read it.
--
-- Additive. Re-runnable: IF NOT EXISTS throughout.
--
-- Reversible:
--   DROP TABLE IF EXISTS anthropic_spend;
CREATE TABLE IF NOT EXISTS "anthropic_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "anthropic_spend_occurred_at_idx" ON "anthropic_spend" ("occurred_at");--> statement-breakpoint
ALTER TABLE "anthropic_spend" ENABLE ROW LEVEL SECURITY;
