-- THE OFFER A GMAIL ALERT MAKES. Additive (rule #9): one new table, nothing existing is
-- altered, and an empty table is byte-for-byte today's behaviour.
--
-- WHY A TABLE AND NOT A ROW ON SOMETHING THAT EXISTS. agent_commitments permits ONE open
-- promise of a kind per family while the outbound gate allows three email alerts a day,
-- so offers two and three would be unwritable; and the row has to carry an OCCASION (a
-- title, an instant, a place) while the ledger's summary is contractually one parent-safe
-- sentence and its topic a closed vocabulary. watched_spots made its own table at exactly
-- this wall, for exactly these two reasons.
--
-- Family-scoped with a cascading FK, which IS the erasure path: runDeletionSweep issues
-- one DELETE FROM families and lets the cascade do the rest (rule #1, PIPEDA).
CREATE TABLE IF NOT EXISTS "email_alert_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	-- WHO WAS ASKED. The offer was put to one parent's phone and only that parent has it
	-- open, the same per-parent rule the intro opt-in and the co-parent scope question
	-- keep. Its own cascade: a user removed from a household is a row the family cascade
	-- would not collect.
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	-- WHICH CONNECTION the email came through, and with the message id the natural identity
	-- of the offer: one email is one offer, forever. NO foreign key, deliberately, the same
	-- call the two created_from columns make: a connection is not this row's lifecycle
	-- parent, and a parent who disconnects Gmail is still holding a text that asked them a
	-- question. A cascade here would delete the standing question out from under it.
	"integration_id" uuid NOT NULL,
	-- The provider's own message id.
	"message_id" text NOT NULL,
	-- The extraction kind the alert was written from. An enum-shaped fact for the audit
	-- row, never a sentence.
	"kind" text NOT NULL,
	-- The extraction's OWN title and place, through the same fold the wire uses. Never the
	-- subject line, never the snippet, never the quote evidence (rule #1). A 13+ child's
	-- mail writes no row at all, so nothing here is ever a genericised teen title.
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"location" text,
	-- The outbound row that carried the call to action. NOT NULL, because an offer nobody
	-- was told about is not an offer: the row is written after the transport accepted it.
	"channel_message_id" uuid NOT NULL REFERENCES "channel_messages"("id") ON DELETE cascade,
	-- When it stops being answerable. Applied AT THE READER, so an expired offer is never
	-- listed, never named in a clarifying sentence and never resolvable.
	"expires_at" timestamp with time zone NOT NULL,
	-- The family_events row this offer placed, claimed BEFORE the insert so a turn that
	-- added the event and then failed to answer is re-drivable without double-placing.
	-- Deliberately no foreign key: the stamp is a claim key, and both tables already
	-- cascade on family deletion (the family_events placed-by-action stamp's own rule).
	"event_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	-- The RECEIPT: the outbound row that told the parent what their answer did. An offer is
	-- only ever closed from afterSend, so it is present exactly when the resolution is, and
	-- the last-word rule reads it — a second yes is still about this offer only while this
	-- message is the last thing Hale said to this parent.
	"resolved_channel_message_id" uuid REFERENCES "channel_messages"("id") ON DELETE cascade,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- A resolution is complete, named and carried by a message the parent got, or it did
	-- not happen. Half of one is an offer quietly deleted, which is the one ending a ledger
	-- must never allow.
	CONSTRAINT "email_alert_offers_resolution_check" CHECK (
		("resolved_at" IS NULL) = ("resolution" IS NULL)
		AND ("resolved_at" IS NULL) = ("resolved_channel_message_id" IS NULL)
		AND ("resolution" IS NULL OR "resolution" IN ('added', 'declined'))
	)
);--> statement-breakpoint

-- One offer per email, as a constraint rather than a convention: a re-fired sweep over a
-- mailbox it has already read conflicts here instead of minting a second question.
CREATE UNIQUE INDEX IF NOT EXISTS "email_alert_offers_message_uniq"
	ON "email_alert_offers" ("integration_id", "message_id");--> statement-breakpoint

-- The reader's whole working set: this parent's open offers, newest first. Partial, so in
-- a healthy system it holds only the questions actually standing.
CREATE INDEX IF NOT EXISTS "email_alert_offers_open_idx"
	ON "email_alert_offers" ("family_id", "parent_user_id", "created_at")
	WHERE "resolved_at" IS NULL;--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The app
-- connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "email_alert_offers" ENABLE ROW LEVEL SECURITY;

-- BUILDER NOTES:
--  * CREATE TABLE and ENABLE ROW LEVEL SECURITY are UNQUALIFIED on purpose:
--    migration-rls-consistency.test.mjs matches only the unqualified form on both sides.
--  * Every create is IF NOT EXISTS so a hand-applied migration re-run past the ledger
--    watermark is a no-op rather than a duplicate_table (migration-rerunnable.test.mjs).
--  * No enum is added or used here: the two vocabularies this table carries (kind,
--    resolution) are TEXT under a CHECK, so a new extraction kind never needs an
--    ALTER TYPE in a transaction that also wants to write it.
