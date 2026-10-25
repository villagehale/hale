-- T8 — each parent's own Stripe Link Agent Wallet authorization.
--
-- Additive. Re-runnable: IF NOT EXISTS throughout. Rows hold an AES-256-GCM blob of
-- the Link OAuth refresh token (rotated on every refresh). No card number is stored.
--
-- Reversible:
--   DROP TABLE IF EXISTS family_link_wallets;
CREATE TABLE IF NOT EXISTS "family_link_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"refresh_token_ciphertext" text NOT NULL,
	"scope" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "family_link_wallets_family_parent_idx" ON "family_link_wallets" ("family_id","parent_user_id");--> statement-breakpoint
ALTER TABLE "family_link_wallets" ENABLE ROW LEVEL SECURITY;
