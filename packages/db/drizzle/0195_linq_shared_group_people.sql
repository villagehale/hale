-- VIL-456 — people Hale has placed in a multi-family group, including
-- members who are not Hale customers. Additive (rule #9). Nothing existing
-- is altered or dropped. Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS linq_shared_group_people;
--
-- family_id is set only from a known Hale number. A guess never writes it,
-- and it is never moved onto another family. stopped_at is one person
-- opting out; the rest of the chat keeps Hale.

CREATE TABLE IF NOT EXISTS "linq_shared_group_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"phone_e164_encrypted" text NOT NULL,
	"phone_e164_hash" text NOT NULL,
	"family_id" uuid REFERENCES "families"("id") ON DELETE set null,
	"user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"inferred_role" text,
	"inferred_family_label" text,
	"inferred_kid_name" text,
	"first_name" text,
	"stopped_at" timestamp with time zone,
	"seated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_shared_group_people_role_check" CHECK ("inferred_role" IS NULL OR "inferred_role" IN ('parent', 'co_parent', 'grandparent', 'nanny', 'caregiver', 'other_family', 'guest', 'unclear'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_shared_group_people_live_chat_phone_uniq" ON "linq_shared_group_people" ("chat_id","phone_e164_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_shared_group_people_family_idx" ON "linq_shared_group_people" ("family_id");--> statement-breakpoint
ALTER TABLE "linq_shared_group_people" ENABLE ROW LEVEL SECURITY;
