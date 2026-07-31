-- VIL-245 · M10 birthday parties + account-less RSVP — two enum values and two tables.
-- Additive only (rule #9): nothing is dropped, no existing value changes meaning.
--
-- 'rsvp' is a channel_messages category of its own for a reason the earlier additions
-- (0071 'nudge', 0073 'registration_sequence') did not have. Those two are separate
-- because a shared category would let one class eat another's CAP. This one is separate
-- because of WHO the rows are about: a party guest has no users row, so every guest
-- message is ledgered against the HOST parent (the M6 caregiver precedent, where a
-- stranger Hale texts on a parent's say-so is likewise attributed to the parent who
-- authorised it). Folding those rows into any parent-facing category would make a
-- family's guest volume read, in a PIPEDA right-to-access export, as messages Hale sent
-- the PARENT — a false statement about what a person received, which is worse than the
-- cap collision the other two were avoiding.
--
-- ADD VALUE is safe alongside the CREATE TABLEs because no data uses either new value in
-- this transaction (same shape as 0070 / 0071 / 0072).
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'rsvp';--> statement-breakpoint
-- 'party' is a family_event_source of its own for a reason the host reply handler
-- depends on: a 'channel' row is any occasion a text mentioned, while a 'party' row is
-- the one thing a "yes, make me a link" may attach a public page to. Sharing 'channel'
-- would let a plain "add Leo's party Sat 2pm" be turned into a shareable page by an
-- unrelated "yes" arriving minutes later.
ALTER TYPE "public"."family_event_source" ADD VALUE IF NOT EXISTS 'party';--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."rsvp_response" AS ENUM('yes', 'no', 'maybe');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "party_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"family_event_id" uuid NOT NULL,
	"host_user_id" uuid NOT NULL,
	"public_token" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "party_rsvps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_invite_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"name_key" text NOT NULL,
	"response" "rsvp_response" NOT NULL,
	"headcount" integer DEFAULT 1 NOT NULL,
	"reminder_opt_in_at" timestamp with time zone,
	"phone_e164_encrypted" text,
	"phone_e164_hash" text,
	"reminder_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- The data-minimisation guarantee lives HERE, not in a code review: a guest who did
	-- not ask for a reminder leaves no contact data behind, and a stored number always
	-- carries the timestamp of the consent that permits holding it. Both directions.
	CONSTRAINT "party_rsvps_reminder_consent_check" CHECK (
		("reminder_opt_in_at" IS NULL) = ("phone_e164_encrypted" IS NULL)
		AND ("reminder_opt_in_at" IS NULL) = ("phone_e164_hash" IS NULL)
	),
	CONSTRAINT "party_rsvps_headcount_check" CHECK ("headcount" >= 1 AND "headcount" <= 20)
);
--> statement-breakpoint
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_family_event_id_family_events_id_fk" FOREIGN KEY ("family_event_id") REFERENCES "public"."family_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_rsvps" ADD CONSTRAINT "party_rsvps_party_invite_id_party_invites_id_fk" FOREIGN KEY ("party_invite_id") REFERENCES "public"."party_invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "party_invites_public_token_uniq" ON "party_invites" ("public_token");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "party_invites_event_uniq" ON "party_invites" ("family_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "party_invites_family_idx" ON "party_invites" ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "party_rsvps_invite_name_uniq" ON "party_rsvps" ("party_invite_id","name_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "party_rsvps_invite_idx" ON "party_rsvps" ("party_invite_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "party_rsvps_phone_idx" ON "party_rsvps" ("phone_e164_hash") WHERE "phone_e164_hash" IS NOT NULL;
