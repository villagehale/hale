-- Group onboarding v2 — who is in a family's Linq group, and what each person has said.
--
-- Additive (rule #9). Two new tables. Nothing existing is altered or dropped.
-- Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS linq_group_roster_members;
--   DROP TABLE IF EXISTS linq_group_rosters;
--
-- Follows 0157_family_workstreams. 0154 is still claimed by an open branch, so
-- this takes 0158 with a `when` above every open claim.
--
-- One roster per chat, built from GET /chats/{id} when Hale is added to a group.
-- family_id stays null until a parent Hale already knows is matched (no_family,
-- mixed_family, not_group and roster_pending rosters hold no family). A member row holds the
-- encrypted number and its blind index; nobody is seated from this table — a seat
-- still lives in linq_group_members and is written only on the person's own reply.
-- A phone has one live row per chat; a member who leaves or is removed keeps the row.

CREATE TABLE IF NOT EXISTS "linq_group_rosters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"family_id" uuid REFERENCES "families"("id") ON DELETE cascade,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"member_count" integer,
	"roster_fetched_at" timestamp with time zone,
	"asked_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"ejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_rosters_source_check" CHECK ("source" IN ('added_to_existing', 'new_group', 'backfill')),
	CONSTRAINT "linq_group_rosters_status_check" CHECK ("status" IN ('roster_pending', 'no_family', 'mixed_family', 'roles_proposed', 'partial', 'confirmed', 'refused', 'ejected', 'not_group'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_rosters_chat_uniq" ON "linq_group_rosters" ("chat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_rosters_family_idx" ON "linq_group_rosters" ("family_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_group_roster_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roster_id" uuid NOT NULL REFERENCES "linq_group_rosters"("id") ON DELETE cascade,
	"chat_id" text NOT NULL,
	"phone_e164_encrypted" text NOT NULL,
	"phone_e164_hash" text NOT NULL,
	"known_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"proposed_role" text DEFAULT 'unknown' NOT NULL,
	"status" text NOT NULL,
	"confirmed_role" text,
	"connect_step" text DEFAULT 'none' NOT NULL,
	"asked_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_group_roster_members_proposed_role_check" CHECK ("proposed_role" IN ('parent', 'grandparent', 'nanny', 'babysitter', 'unknown')),
	CONSTRAINT "linq_group_roster_members_status_check" CHECK ("status" IN ('known_parent', 'proposed', 'asked', 'reasked', 'confirmed', 'declined', 'not_family', 'refused', 'left', 'removed')),
	CONSTRAINT "linq_group_roster_members_confirmed_role_check" CHECK ("confirmed_role" IN ('co_parent', 'grandparent', 'nanny', 'babysitter')),
	CONSTRAINT "linq_group_roster_members_connect_step_check" CHECK ("connect_step" IN ('none', 'link_sent', 'unreachable', 'done'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_roster_members_live_uniq" ON "linq_group_roster_members" ("chat_id","phone_e164_hash") WHERE "status" NOT IN ('left', 'removed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_roster_members_roster_idx" ON "linq_group_roster_members" ("roster_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_roster_members_phone_idx" ON "linq_group_roster_members" ("phone_e164_hash");--> statement-breakpoint
ALTER TABLE "linq_group_rosters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "linq_group_roster_members" ENABLE ROW LEVEL SECURITY;
