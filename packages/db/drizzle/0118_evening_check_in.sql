-- VIL-353 · THE EVENING CHECK-IN. Every evening Hale asks the parent how the day went,
-- and keeps the answer between the two of them. Additive (rule #9): one new enum type,
-- two new tables and one new outbound category. Nothing existing is altered, and two
-- empty tables are byte-for-byte today's behaviour.
--
-- WHY THE ANSWER GETS A TABLE OF ITS OWN INSTEAD OF A MEMORY FACT. family_memory_facts is
-- the shared store every memory reader already queries and feeds to a model, and this row
-- holds a parent's own unedited sentence about their household. Rule #1 says that sentence
-- never reaches a shared, teen- or caregiver-readable surface, and the only way to make
-- that true by construction rather than by vigilance is for the raw words to live
-- somewhere no existing reader looks. The fact store also cannot express the two
-- properties this data needs: it has no expiry column, and its one-live-row-per-key index
-- would have each evening silently supersede the last.
--
-- Both tables are family-scoped with a cascading FK, which IS the erasure path:
-- runDeletionSweep issues one DELETE FROM families and lets the cascade do the rest
-- (rule #1, PIPEDA).
DO $$ BEGIN
  CREATE TYPE "public"."check_in_cadence" AS ENUM('daily', 'weekly', 'off');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- How often this household hears the evening question, and what the ladder knows about
-- their silence. One row per family, minted on the first ask.
CREATE TABLE IF NOT EXISTS "family_check_in_prefs" (
	"family_id" uuid PRIMARY KEY REFERENCES "families"("id") ON DELETE cascade,
	-- daily by default, and the parent moves it with a word. off is dormant, not deleted:
	-- a household that stopped answering is re-offered nothing, and a household that said
	-- no is honoured forever, and both are the same column.
	"cadence" "check_in_cadence" DEFAULT 'daily' NOT NULL,
	-- Consecutive asks that lapsed unanswered, counted at the next ask rather than by a
	-- timer, so a lapse is counted exactly once whatever the cron does.
	"silent_streak" integer DEFAULT 0 NOT NULL,
	-- When the question last went out, and when the parent last said anything back. The
	-- pair is the whole state machine: last_answered_at older than last_asked_at is a
	-- lapse, and there is no third column that could disagree with it.
	"last_asked_at" timestamp with time zone,
	"last_answered_at" timestamp with time zone,
	-- The evening a rung of the ladder last acted on this family's silence. An ask older
	-- than it has already been counted by the step-down that answered it, which is the
	-- only thing that makes "three more weekly asks" mean three and not two.
	"silent_streak_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "family_check_in_prefs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- What the parent actually said, in their own words. THE MOST SENSITIVE TABLE IN THIS
-- FEATURE, and the reason every column below exists is to bound it:
--   · parent_user_id is who said it, so a right-to-access read can separate two parents.
--   · source_message_id is the inbound row that carried the words, and the cascade means
--     erasing the message erases the note derived from it (rule #6 provenance both ways).
--   · expires_at is the 30-day raw TTL, STORED rather than derived from created_at, so
--     shortening the constant later cannot silently extend the life of a row already
--     written.
CREATE TABLE IF NOT EXISTS "family_check_in_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"source_message_id" uuid NOT NULL REFERENCES "channel_messages"("id") ON DELETE cascade,
	-- The family-local calendar day the note is ABOUT, not the instant it arrived: a
	-- parent answering at 00:20 is telling Hale about the day that just ended.
	"noted_on" date NOT NULL,
	"note" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "family_check_in_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- One note per family per evening. A parent who answers twice is correcting themselves,
-- not writing a second day.
CREATE UNIQUE INDEX IF NOT EXISTS "family_check_in_notes_day_uniq"
	ON "family_check_in_notes" ("family_id", "noted_on");--> statement-breakpoint

-- The retention sweep's working set: the rows whose thirty days are up.
CREATE INDEX IF NOT EXISTS "family_check_in_notes_expiry_idx"
	ON "family_check_in_notes" ("expires_at");--> statement-breakpoint

-- Its own outbound category, for the reason every proactive class has one: the gate
-- COUNTS a category, so sharing another class would spend a budget these texts were never
-- meant to govern, and the nudge cap would then read as spent by a question the nudge
-- sweep never asked. It is Hale making contact first, so the loop-health digest EXCLUSION
-- list is correct to leave it out.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'evening_check_in';
