-- VIL-732: the claim reader's refused verdict on a dispatch leg, kept beside the failed
-- channel_messages row it explains. Today a refused reminder leaves only
-- error_code = 'unbacked_claim', so which claim was refused, what it cited and what the
-- reader was offered is gone.
--
-- It holds no body and no row label: per claim its segment index, kind, cited alias,
-- status and why; per call how many rows of each source were offered and any slot cap.
-- Erasure is the cascade from the channel_messages row (and so from the family).
-- Written only while CLAIM_REFUSAL_STORE_ENABLED is exactly 'true'.
--
-- Additive (rule #9). Re-runnable: IF NOT EXISTS throughout. Reversible:
--   DROP TABLE IF EXISTS claim_refusals;
CREATE TABLE IF NOT EXISTS "claim_refusals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"channel_message_id" uuid NOT NULL REFERENCES "channel_messages"("id") ON DELETE cascade,
	"claims" jsonb NOT NULL,
	"candidates" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_refusals_channel_message_idx" ON "claim_refusals" ("channel_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_refusals_family_created_idx" ON "claim_refusals" ("family_id","created_at");--> statement-breakpoint
ALTER TABLE "claim_refusals" ENABLE ROW LEVEL SECURITY;
