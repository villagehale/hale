-- Single-use, expiring magic-link (passwordless) sign-in tokens (additive only,
-- rule #9). A magic link grants a signed-in session — account takeover if leaked —
-- so ONLY its SHA-256 hash is stored (never the token itself, rule #1). Unlike
-- password_reset_tokens, this keys off `email` (no FK to credentials): a magic link
-- doubles as first-time sign-up, so it must be mintable for an address with no
-- credentials row yet. `consumed_at` burns it on redemption (single use, via an
-- atomic conditional UPDATE); `expires_at` bounds the ~15-minute window.
CREATE TABLE IF NOT EXISTS "magic_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The redeem lookup is by token_hash; UNIQUE both indexes it and guarantees a hash
-- collision can never map one link to two accounts.
CREATE UNIQUE INDEX IF NOT EXISTS "magic_link_tokens_token_hash_unique" ON "magic_link_tokens" USING btree ("token_hash");--> statement-breakpoint
-- A new request invalidates an email's prior unconsumed tokens, an indexed scan.
CREATE INDEX IF NOT EXISTS "magic_link_tokens_email_idx" ON "magic_link_tokens" USING btree ("email");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0012/0023/0028.
-- The app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1 —
-- sign-in tokens must never be reachable through the public Data API.
ALTER TABLE "magic_link_tokens" ENABLE ROW LEVEL SECURITY;
