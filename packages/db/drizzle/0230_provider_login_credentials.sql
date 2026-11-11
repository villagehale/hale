-- VIL-558 · parent city-site login link, plan-scoped sessions, and encrypted
-- credentials (Barton, 11/10/2026: Hale may encrypt and store the city username,
-- password and optional TOTP seed, replacing the 10/21 session-only rule).
--
-- Additive (rule #9). Re-runnable: IF NOT EXISTS throughout. Reversible:
--   DROP TABLE IF EXISTS provider_login_notices;
--   DROP TABLE IF EXISTS provider_login_links;
--   DROP TABLE IF EXISTS provider_signup_credentials; -- includes stale_at
--   DROP TABLE IF EXISTS family_provider_data_keys;
--   ALTER TABLE provider_signup_sessions DROP COLUMN IF EXISTS account_warning;
--   ALTER TABLE provider_signup_sessions DROP COLUMN IF EXISTS last_validated_at;
--   ALTER TABLE provider_signup_sessions DROP COLUMN IF EXISTS last_keepalive_at;
--   DROP INDEX IF EXISTS authorized_signup_offers_one_pending_per_host;
--   CREATE UNIQUE INDEX IF NOT EXISTS authorized_signup_offers_one_pending ON authorized_signup_offers (family_id) WHERE status = 'pending';
--   ALTER TABLE authorized_signup_offers DROP COLUMN IF EXISTS plan_availability_at;
--   ALTER TABLE authorized_signup_offers DROP COLUMN IF EXISTS plan_availability;
--   ALTER TABLE authorized_signup_offers DROP COLUMN IF EXISTS plan_already_open;
--   ALTER TABLE authorized_signup_offers DROP COLUMN IF EXISTS provider_host;
CREATE TABLE IF NOT EXISTS "family_provider_data_keys" (
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"key_version" integer NOT NULL,
	"wrapped_dek" text NOT NULL,
	"master_key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_provider_data_keys_pk" PRIMARY KEY ("family_id","key_version")
);--> statement-breakpoint
ALTER TABLE "family_provider_data_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_signup_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"provider_host" text NOT NULL,
	"username_ciphertext" text NOT NULL,
	"password_ciphertext" text NOT NULL,
	"totp_seed_ciphertext" text,
	"dek_version" integer NOT NULL,
	"master_key_version" integer NOT NULL,
	"stale_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_signup_credentials_host_length_check" CHECK (char_length("provider_host") <= 253)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_signup_credentials_family_host_idx" ON "provider_signup_credentials" ("family_id","provider_host");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_signup_credentials_family_idx" ON "provider_signup_credentials" ("family_id");--> statement-breakpoint
ALTER TABLE "provider_signup_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_login_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"offer_id" uuid REFERENCES "authorized_signup_offers"("id") ON DELETE cascade,
	"provider_host" text NOT NULL,
	"token_hash" text NOT NULL,
	"browser_id" text,
	"browser_handle_ciphertext" text,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" jsonb,
	CONSTRAINT "provider_login_links_host_length_check" CHECK (char_length("provider_host") <= 253)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_login_links_token_hash_idx" ON "provider_login_links" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_login_links_family_idx" ON "provider_login_links" ("family_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_login_links_expires_idx" ON "provider_login_links" ("expires_at");--> statement-breakpoint
ALTER TABLE "provider_login_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_login_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"offer_id" uuid NOT NULL REFERENCES "authorized_signup_offers"("id") ON DELETE cascade,
	"provider_host" text NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_login_notices_offer_kind_idx" ON "provider_login_notices" ("offer_id","kind");--> statement-breakpoint
ALTER TABLE "provider_login_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_signup_sessions" ADD COLUMN IF NOT EXISTS "last_keepalive_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_signup_sessions" ADD COLUMN IF NOT EXISTS "last_validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_signup_sessions" ADD COLUMN IF NOT EXISTS "account_warning" text;--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "provider_host" text;--> statement-breakpoint
UPDATE "authorized_signup_offers"
SET "provider_host" = lower(regexp_replace(split_part(split_part("registration_url", '://', 2), '/', 1), '\.$', ''))
WHERE "provider_host" IS NULL AND "registration_url" LIKE '%://%';--> statement-breakpoint
UPDATE "authorized_signup_offers" SET "provider_host" = 'unknown.host' WHERE "provider_host" IS NULL OR "provider_host" = '';--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ALTER COLUMN "provider_host" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "plan_already_open" boolean;--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "plan_availability" jsonb;--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "plan_availability_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX IF EXISTS "authorized_signup_offers_one_pending";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "authorized_signup_offers_one_pending_per_host"
	ON "authorized_signup_offers" ("family_id","provider_host")
	WHERE "status" = 'pending';
