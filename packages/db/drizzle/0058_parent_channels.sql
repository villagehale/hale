-- VIL-212 · Phone verification + CASL express consent (additive only, rule #9).
-- Slot 0058 is pre-assigned; Wave-1 migrations 0054-0057 land ahead of it.
--
-- Three additive changes for the loop's SMS front door:
--   1. a new consent_type value for CASL express SMS consent (per-parent);
--   2. parent_channels — a parent's verified SMS channel (phone ENCRYPTED at rest);
--   3. phone_verifications — ephemeral OTP state (code stored SHA-256-HASHED only).
-- No data uses the new enum value in this transaction, so ADD VALUE is safe here.
ALTER TYPE "public"."consent_type" ADD VALUE IF NOT EXISTS 'sms_service_messages';--> statement-breakpoint
-- A parent's verified outbound channel (v1: SMS). The phone is among the most
-- sensitive data we hold (rule #1) so it is stored ENCRYPTED (AES-256-GCM via
-- APP_ENCRYPTION_KEY — the integration token-vault envelope), never plaintext.
-- Per-PARENT (co-parents enroll independently; rule #5 not triggered).
-- phone_e164_hash is a deterministic keyed BLIND INDEX (HMAC-SHA256 of the canonical
-- E.164) — the encrypted blob uses a random IV so can't be searched by equality; the
-- inbound-SMS webhook (A3) resolves an incoming From → parent by this hash.
CREATE TABLE IF NOT EXISTS "parent_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE CASCADE,
	"kind" text NOT NULL DEFAULT 'sms',
	"phone_e164_encrypted" text NOT NULL,
	"phone_e164_hash" text NOT NULL,
	"verified_at" timestamp with time zone,
	"consent_record_id" uuid REFERENCES "consent_records"("id"),
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- At most one ACTIVE channel per (parent, kind); revoked rows are unconstrained
-- history. Enrollment revoke-then-inserts, so a number change keeps the old row
-- (soft-revoked) for audit while the partial index still bars two active channels.
CREATE UNIQUE INDEX IF NOT EXISTS "parent_channels_user_kind_active_idx" ON "parent_channels" USING btree ("user_id","kind") WHERE "revoked_at" IS NULL;--> statement-breakpoint
-- At most one ACTIVE channel per number, so the inbound From lookup resolves to a
-- single parent. Partial (active only) so a revoked row keeps its hash and a recycled
-- number can be re-enrolled by its new holder.
CREATE UNIQUE INDEX IF NOT EXISTS "parent_channels_phone_hash_active_idx" ON "parent_channels" USING btree ("phone_e164_hash") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parent_channels_user_idx" ON "parent_channels" USING btree ("user_id");--> statement-breakpoint
-- Ephemeral OTP state. The 6-digit code grants a verify, so ONLY its SHA-256 hash
-- is stored (rule #1); the number under verification is stored encrypted. attempt
-- counter + expiry give "3 wrong tries locks for 10 min"; last_sent_at gates the
-- 60s resend cooldown; a new send invalidates prior unconsumed rows.
CREATE TABLE IF NOT EXISTS "phone_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"phone_e164_encrypted" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_verifications_user_idx" ON "phone_verifications" USING btree ("user_id");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0051. The app
-- connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1 — verified
-- phone numbers and OTP hashes must never be reachable through the public Data API.
ALTER TABLE "parent_channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "phone_verifications" ENABLE ROW LEVEL SECURITY;
