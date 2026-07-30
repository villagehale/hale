-- VIL-241 · M6 caregiver roles — scoped access for a grandparent / nanny / babysitter.
-- Additive only (rule #9): six enum values and one new table. Nothing is dropped and
-- no existing value changes meaning.
--
-- The new family_role values are the NAMED caregiver roles. The pre-existing vague
-- buckets ('extended', 'service') are left in place and left meaningless: no flow
-- grants them and the scope matrix gives them nothing.
--
-- No data uses any new enum value in this transaction — caregiver_invites.role only
-- REFERENCES the type, it stores no literal here — so ADD VALUE is safe alongside the
-- CREATE TABLE.
ALTER TYPE "public"."family_role" ADD VALUE IF NOT EXISTS 'grandparent';--> statement-breakpoint
ALTER TYPE "public"."family_role" ADD VALUE IF NOT EXISTS 'nanny';--> statement-breakpoint
ALTER TYPE "public"."family_role" ADD VALUE IF NOT EXISTS 'babysitter';--> statement-breakpoint
ALTER TYPE "public"."consent_type" ADD VALUE IF NOT EXISTS 'caregiver_access_grant';--> statement-breakpoint
ALTER TYPE "public"."consent_type" ADD VALUE IF NOT EXISTS 'caregiver_scoped_messages';--> statement-breakpoint
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'caregiver';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "caregiver_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"role" "family_role" NOT NULL,
	"display_name" text NOT NULL,
	"phone_e164_encrypted" text NOT NULL,
	"phone_e164_hash" text NOT NULL,
	"state" text NOT NULL,
	"caregiver_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "caregiver_invites" ADD CONSTRAINT "caregiver_invites_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caregiver_invites" ADD CONSTRAINT "caregiver_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caregiver_invites" ADD CONSTRAINT "caregiver_invites_caregiver_user_id_users_id_fk" FOREIGN KEY ("caregiver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "caregiver_invites_phone_open_idx" ON "caregiver_invites" ("phone_e164_hash") WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "caregiver_invites_family_idx" ON "caregiver_invites" ("family_id");
