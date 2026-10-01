-- VIL-398 — a household Linq group can hold any number of members.
--
-- Additive (rule #9). A new table only. Nothing existing is altered.
-- Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS linq_group_members;
--
-- Follows 0145_optional_ask_ledger. This ticket takes 0146.
--
-- One live seat per phone in a chat, and one live seat per phone across
-- chats, so a number already in another family cannot be seated here.
-- There is no member-count check: grandparents and other family are not capped.
-- The phone is stored the same way a parent's is — encrypted blob plus blind
-- index — and never in plaintext. removed_at is the unseat. Closed rows stay.

CREATE TABLE IF NOT EXISTS "linq_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"chat_id" text NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"phone_e164_encrypted" text NOT NULL,
	"phone_e164_hash" text NOT NULL,
	"role" text NOT NULL,
	"added_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"seated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"welcomed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_members_role_check" CHECK ("role" IN ('parent', 'co_parent', 'other_family', 'caregiver'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_members_live_chat_phone_uniq" ON "linq_group_members" ("chat_id","phone_e164_hash") WHERE "removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_members_live_phone_uniq" ON "linq_group_members" ("phone_e164_hash") WHERE "removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_members_family_idx" ON "linq_group_members" ("family_id");--> statement-breakpoint
ALTER TABLE "linq_group_members" ENABLE ROW LEVEL SECURITY;
