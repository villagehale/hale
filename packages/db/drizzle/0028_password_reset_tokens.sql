-- Single-use, expiring password-reset tokens (additive only, rule #9). A reset
-- token grants a password change — account takeover if leaked — so ONLY its
-- SHA-256 hash is stored (never the token itself, rule #1). One row per issued
-- token: `used_at` burns it on redemption (single use), `expires_at` bounds the
-- window. FK to credentials with ON DELETE CASCADE so a deleted account can leave
-- no dangling reset link.
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid NOT NULL REFERENCES "credentials"("id") ON DELETE CASCADE,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The redeem lookup is by token_hash; UNIQUE both indexes it and guarantees a hash
-- collision can never map one link to two accounts.
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_unique" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
-- A new request invalidates a credential's prior unused tokens, an indexed scan.
CREATE INDEX IF NOT EXISTS "password_reset_tokens_credential_idx" ON "password_reset_tokens" USING btree ("credential_id");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0012/0023.
-- The app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1 —
-- reset tokens must never be reachable through the public Data API.
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
