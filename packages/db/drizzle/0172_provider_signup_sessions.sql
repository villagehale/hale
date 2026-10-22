-- T8 — encrypted provider sessions for the Browser Use signup engine.
--
-- Additive. Re-runnable: IF NOT EXISTS throughout. Rows hold an AES-256-GCM blob of
-- cookies and local storage (never a password) and are deleted after the parent says
-- they are in, or by the hourly delete sweep once expires_at (captured + 48h) passes.
--
-- Reversible:
--   DROP TABLE IF EXISTS provider_signup_sessions;
CREATE TABLE IF NOT EXISTS "provider_signup_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"provider_host" text NOT NULL,
	"storage_state_ciphertext" text NOT NULL,
	"browser_use_profile_id" text,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_signup_sessions_host_length_check" CHECK (char_length("provider_host") <= 253)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_signup_sessions_family_host_idx" ON "provider_signup_sessions" ("family_id","provider_host");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_signup_sessions_expires_idx" ON "provider_signup_sessions" ("expires_at");--> statement-breakpoint
ALTER TABLE "provider_signup_sessions" ENABLE ROW LEVEL SECURITY;
