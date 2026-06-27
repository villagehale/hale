-- Email + password identities, alongside Google OAuth (additive only, rule #9).
-- One row per credential: a lowercased UNIQUE email, an argon2id password hash
-- (never plaintext, rule #1), and email-verification state (verified_at + a
-- single-use token bounded by sent_at). The mirrored `users` row keys off
-- external_auth_id = 'credentials:<id>', so the downstream family-linking flow is
-- identical to a Google user's. The unique email index is the source of truth for
-- duplicate sign-ups (race-safe), not an app-level pre-check.
CREATE TABLE IF NOT EXISTS "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"verification_token" text,
	"verification_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credentials_email_unique" ON "credentials" USING btree ("email");--> statement-breakpoint
-- Partial unique index on the verification token: each active (unredeemed) token
-- is unique and the redeem lookup is indexed, while the many NULLs (verified /
-- expired rows, where the token is cleared) are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS "credentials_verification_token_unique" ON "credentials" USING btree ("verification_token") WHERE "verification_token" IS NOT NULL;--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0012/0019/0020/0022.
-- The app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1 —
-- password hashes must never be reachable through the public Data API.
ALTER TABLE "credentials" ENABLE ROW LEVEL SECURITY;
