-- VIL-237 · M2 conversational SMS intake — the phone number becomes the account.
-- Additive only (rule #9): one NOT NULL relaxed, two nullable columns, three enum
-- values, one new table. Nothing is dropped and no existing value changes meaning.
--
-- `users.email` DROP NOT NULL: an SMS-provisioned parent has no email address at
-- all. The UNIQUE index stays — Postgres allows many NULLs in a unique index, so
-- "one account per address" still holds for every parent who does have one.
ALTER TYPE "public"."onboarding_stage" ADD VALUE IF NOT EXISTS 'sms_intake';--> statement-breakpoint
ALTER TYPE "public"."onboarding_stage" ADD VALUE IF NOT EXISTS 'sms_active';--> statement-breakpoint
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'intake';--> statement-breakpoint
ALTER TYPE "public"."consent_type" ADD VALUE IF NOT EXISTS 'proactive_watch';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "children" ADD COLUMN IF NOT EXISTS "dob_precision" text DEFAULT 'exact' NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "evidence" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_intake_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_hash" text NOT NULL,
	"phone_encrypted" text NOT NULL,
	"state" text NOT NULL,
	"source_code" text,
	"data_encrypted" text NOT NULL,
	"follow_up_count" integer DEFAULT 0 NOT NULL,
	"clarify_count" integer DEFAULT 0 NOT NULL,
	"family_id" uuid,
	"user_id" uuid,
	"last_provider_id" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sms_intake_sessions" ADD CONSTRAINT "sms_intake_sessions_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_intake_sessions" ADD CONSTRAINT "sms_intake_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sms_intake_sessions_phone_open_idx" ON "sms_intake_sessions" ("phone_hash") WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_intake_sessions_provider_idx" ON "sms_intake_sessions" ("last_provider_id");
