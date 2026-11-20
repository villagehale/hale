-- VIL-686: a Secret Santa drawn in a multi-family group and sent to each giver 1:1.
--
-- secret_santa_draws: one draw per shared Linq chat (chat_id). At most one live draw
-- (collecting or drawn) per chat. The organizer is a linq_shared_group_people row; their
-- Hale family and user are kept so the draw's audit rows have a home after they leave.
--
-- secret_santa_participants: who is in, by people row, with the name they gave (called).
-- receiver_encrypted is the giver's receiver: the receiver's participant id, encrypted.
-- It is not a foreign key, because a foreign key column would itself be the pairing in
-- a row dump. It is nulled the moment that giver's draw is delivered.
--
-- held_reason names why a giver's draw has not gone yet. It never refers to a receiver.
--
-- Rows are purged 45 days after drawn_at or cancelled_at (delete-sweep).
--
-- Additive. Re-runnable: IF NOT EXISTS throughout.
--
-- Reversible:
--   DROP TABLE IF EXISTS secret_santa_participants;
--   DROP TABLE IF EXISTS secret_santa_draws;
CREATE TABLE IF NOT EXISTS "secret_santa_draws" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"organizer_person_id" uuid REFERENCES "linq_shared_group_people"("id") ON DELETE set null,
	"organizer_family_id" uuid REFERENCES "families"("id") ON DELETE set null,
	"organizer_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"status" text NOT NULL,
	"language" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drawn_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"stale_at" timestamp with time zone,
	"missing_noted_at" timestamp with time zone,
	"stale_noted_at" timestamp with time zone,
	CONSTRAINT "secret_santa_draws_status_check" CHECK ("status" IN ('collecting', 'drawn', 'cancelled')),
	CONSTRAINT "secret_santa_draws_language_length_check" CHECK ("language" IS NULL OR char_length("language") BETWEEN 1 AND 35)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secret_santa_draws_live_chat_uniq" ON "secret_santa_draws" ("chat_id") WHERE "status" IN ('collecting', 'drawn');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_santa_draws_status_idx" ON "secret_santa_draws" ("status", "started_at");--> statement-breakpoint
ALTER TABLE "secret_santa_draws" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_santa_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draw_id" uuid NOT NULL REFERENCES "secret_santa_draws"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "linq_shared_group_people"("id") ON DELETE cascade,
	"called" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receiver_encrypted" text,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"held_reason" text,
	CONSTRAINT "secret_santa_participants_called_length_check" CHECK ("called" IS NULL OR char_length("called") BETWEEN 1 AND 40),
	CONSTRAINT "secret_santa_participants_held_reason_check" CHECK ("held_reason" IS NULL OR "held_reason" IN ('not_texted_hale', 'opted_out', 'opt_out_unread', 'quiet_hours', 'line_held', 'cannot_open_1to1', 'line_unwritten', 'send_failed', 'claim_stuck', 'stopped', 'draw_stale'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secret_santa_participants_draw_person_uniq" ON "secret_santa_participants" ("draw_id", "person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_santa_participants_draw_idx" ON "secret_santa_participants" ("draw_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_santa_participants_person_idx" ON "secret_santa_participants" ("person_id");--> statement-breakpoint
ALTER TABLE "secret_santa_participants" ENABLE ROW LEVEL SECURITY;
