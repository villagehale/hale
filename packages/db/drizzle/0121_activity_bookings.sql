-- THE BOOKING A CONFIRMATION RECORDS. Additive (rule #9): one new table, nothing existing
-- is altered, and an empty table is byte-for-byte today's behaviour.
--
-- WHY A TABLE AND NOT A COLUMN ON family_events. Three reasons, each structural. A booking
-- exists BEFORE any calendar row does and survives a parent who never answers the offer,
-- so it cannot live on a row that only exists after a YES. family_events is read by the
-- weekly composer, the ICS feed, the reconcile view, the coach's schedule reader and the
-- reminder converger, and a provider host plus a parent id on it widens five readers'
-- blast radius for one feature. And the one thing this ticket needs from the row - may
-- Hale ask how it went, and WHOM does it ask - is a property of the BOOKING, not of who
-- authored the calendar entry; putting it on the event is what produced the three-way
-- `source` split in the first place.
--
-- WHY NOT agent_commitments. `agent_commitments_open_kind_uniq` permits ONE open promise
-- of a kind per family while a household books two classes in a September week - the
-- identical wall watched_spots and email_alert_offers both hit and both answered with
-- their own table. And nothing here was promised out loud: `created_from` NOT NULL exists
-- because that ledger records sentences Hale SAID, and the booking text promises no
-- follow-up.
--
-- NO STATUS COLUMN, following watched_spots and registration_sequences. "Is the follow-up
-- still due" is a query - first_session_at inside the window and no channel_messages row
-- carrying the dedupe key. "Is it on the calendar" is `event_id IS NOT NULL`.
--
-- Family-scoped with a cascading FK, which IS the erasure path: runDeletionSweep issues
-- one DELETE FROM families and lets the cascade do the rest (rule #1, PIPEDA).
CREATE TABLE IF NOT EXISTS "activity_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	-- WHOSE MAILBOX THIS CAME FROM, and therefore WHOSE PHONE the follow-up goes to. This
	-- is the privacy field, not a convenience one. The alert already texts this parent and
	-- the offer is already answerable only by them; the ask four days later must not cross
	-- to the other parent, who may not know this registration happened (rule #5, D13). Its
	-- own cascade: a co-parent who leaves the household is a row the family cascade would
	-- not collect.
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	-- WHICH CONNECTION and WHICH RECEIPT - together the natural identity of the booking.
	-- No FK on integration_id, the same call email_alert_offers and the two created_from
	-- columns make: a parent who disconnects Gmail still went to the class.
	"integration_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	-- The bare DOMAIN of the confirming sender. Provenance, and the only stable non-title
	-- identity a later review pool could aggregate on. NEVER the display name (which can
	-- carry a child's program name), never the local part (which can be parent.name@),
	-- never the full address. It is NOT copied into audit_log - that row carries one
	-- boolean - so this table is the single place it lives.
	"provider_host" text NOT NULL,
	-- The extraction's own title, through sanitizedTitle - the same string the text said
	-- and the same fold the wire uses. Never the subject line, never the snippet, never the
	-- quote evidence. Confirmation numbers, order ids, amounts and child names have NO
	-- COLUMN here and are therefore unwritable, which is stronger than a redaction step;
	-- the extraction schema gives the model no field to put them in and the skill is told
	-- not to fold them into the title.
	"title" text NOT NULL,
	"first_session_at" timestamp with time zone NOT NULL,
	"location" text,
	-- The family_events row this booking is ON. ONE meaning, two writers: the correlation
	-- stamps it at detection when the class is already on the calendar, and the offer
	-- stamps it when the parent says yes. The two can never race - a booking that
	-- correlated makes no offer at all - so at most one of them ever runs. No FK: a claim
	-- key, and both tables cascade on family deletion.
	"event_id" uuid,
	-- The outbound row that told the parent. NOT NULL: the booking is written AFTER the
	-- transport accepted the text (the MEM-10 send-time discipline), because a booking
	-- recorded from a text that never went is a fact Hale will act on a week later with
	-- nobody having been told. The cascade ties a booking's life to that message row - safe
	-- today (no purge of channel_messages exists), and a future ledger-retention sweep must
	-- be taught about this table before it deletes one.
	"channel_message_id" uuid NOT NULL REFERENCES "channel_messages"("id") ON DELETE cascade,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- One booking per email, as a constraint rather than a convention: a re-fired sweep over a
-- mailbox it has already read conflicts here instead of minting a second booking. It is
-- also the key stampBookingEvent addresses a row by, so the offer and the booking - two
-- rows born from ONE email - need no third id threaded between them.
CREATE UNIQUE INDEX IF NOT EXISTS "activity_bookings_message_uniq"
	ON "activity_bookings" ("integration_id", "message_id");--> statement-breakpoint

-- The follow-up reader's whole working set: this family's bookings by first session. A
-- PLAIN composite index and not a partial one - the window is relative to `now`, so there
-- is no constant predicate to make it partial with.
CREATE INDEX IF NOT EXISTS "activity_bookings_due_idx"
	ON "activity_bookings" ("family_id", "first_session_at");--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The app
-- connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "activity_bookings" ENABLE ROW LEVEL SECURITY;

-- BUILDER NOTES:
--  * CREATE TABLE and ENABLE ROW LEVEL SECURITY are UNQUALIFIED on purpose:
--    migration-rls-consistency.test.mjs matches only the unqualified form on both sides.
--  * Every create is IF NOT EXISTS so a hand-applied migration re-run past the ledger
--    watermark is a no-op rather than a duplicate_table (migration-rerunnable.test.mjs).
--  * NO enum and NO check constraint: the only vocabulary this table would have carried
--    was cut, so there is no ALTER TYPE and no second file a vocabulary test would have to
--    be taught about.
