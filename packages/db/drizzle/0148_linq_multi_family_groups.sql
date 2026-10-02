-- VIL-399 — a Linq group may hold members from more than one family.
--
-- Additive (rule #9). New tables and one consent_type value. Nothing existing
-- is altered or dropped. Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS linq_multi_family_ledger;
--   DROP TABLE IF EXISTS linq_multi_family_members;
--   DROP TABLE IF EXISTS linq_multi_family_joins;
-- The consent_type value stays; enum values cannot be removed in place.
--
-- Follows 0146_linq_group_members. 0147 is in flight elsewhere. This ticket
-- takes 0148.
--
-- A family is in the shared group only after a parent of THAT family joins.
-- The join points at that family's consent row. linq_group_members is unchanged,
-- including its one-live-seat-per-phone rule, so a household seat and a shared
-- seat are different tables. A phone may be in both.

ALTER TYPE "public"."consent_type" ADD VALUE IF NOT EXISTS 'multi_family_group';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_multi_family_joins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"joined_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"consent_record_id" uuid REFERENCES "consent_records"("id"),
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_multi_family_joins_live_uniq" ON "linq_multi_family_joins" ("chat_id","family_id") WHERE "left_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_multi_family_joins_family_idx" ON "linq_multi_family_joins" ("family_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_multi_family_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"phone_e164_encrypted" text NOT NULL,
	"phone_e164_hash" text NOT NULL,
	"role" text NOT NULL,
	"seated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_multi_family_members_role_check" CHECK ("role" IN ('parent', 'co_parent', 'other_family', 'caregiver'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_multi_family_members_live_chat_phone_uniq" ON "linq_multi_family_members" ("chat_id","phone_e164_hash") WHERE "removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_multi_family_members_family_idx" ON "linq_multi_family_members" ("family_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_multi_family_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_multi_family_ledger_kind_check" CHECK ("kind" IN ('ask', 'send'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_multi_family_ledger_chat_idx" ON "linq_multi_family_ledger" ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_multi_family_ledger_family_idx" ON "linq_multi_family_ledger" ("family_id","chat_id","created_at");--> statement-breakpoint
ALTER TABLE "linq_multi_family_joins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "linq_multi_family_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "linq_multi_family_ledger" ENABLE ROW LEVEL SECURITY;
