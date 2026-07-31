-- VIL-242 (M7 · registration prepare-and-remind) — additive only (rule #9): one new
-- enum value, one new enum type, one new table. Nothing existing is altered or dropped.
--
-- 'registration_sequence' is a channel_messages category of its own for the mirror of
-- the reason 'nudge' got one in 0071: the outbound gate deliberately leaves this class
-- UNCAPPED, so sharing the 'nudge' category would let a family's approved registration
-- legs consume the weekly nudge budget, and would make the nudge cap read as spent by
-- messages it was never meant to govern.
--
-- ADD VALUE is safe here because the new value is not USED in this transaction (same
-- shape as 0070 / 0071); the new type below is created before the table that uses it.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'registration_sequence';--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."registration_outcome" AS ENUM('registered', 'waitlisted', 'missed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "registration_sequences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "window_id" uuid NOT NULL REFERENCES "registration_windows"("id") ON DELETE cascade,
  "parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "action_id" uuid REFERENCES "actions"("id") ON DELETE set null,
  "outcome" "registration_outcome",
  "outcome_at" timestamp with time zone,
  "waitlist_position" integer,
  "waitlist_started_at" timestamp with time zone,
  "waitlist_deadline_at" timestamp with time zone,
  "reasked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- The claim's natural key: one ladder per family per window. Also the anchor the
-- hourly sweep's INSERT ... ON CONFLICT DO NOTHING uses, so a double cron tick can
-- never mint two ladders (or two shortlist drafts) for the same window.
CREATE UNIQUE INDEX IF NOT EXISTS "registration_sequences_family_window_uniq"
  ON "registration_sequences" ("family_id", "window_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "registration_sequences_family_idx"
  ON "registration_sequences" ("family_id", "created_at");
