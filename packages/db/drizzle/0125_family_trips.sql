-- A BOOKING EMAIL BECOMES ONE TEXT A WEEK BEFORE. Additive (rule #9): one new table plus
-- one enum value, nothing existing is altered, and an empty table is byte-for-byte
-- today's behaviour.
--
-- PROVISIONAL NUMBER. The brief specified 0123; main's tail had already taken it
-- (0123_village_candidate_civic_venue), so this is 0124 and the orchestrator re-checks
-- the ordering at merge. `migration-journal-consistency` allows a numbering GAP and
-- refuses a hand-assigned COLLISION, so moving up is the safe direction.
--
-- WHY A TABLE AND NOT A COMMITMENT KIND. agent_commitments.created_from is NOT NULL
-- against the outbound channel_messages row that carried the promise -- and a trip is
-- NOTICED, never promised, so there is no such row at write time. Its partial unique
-- index permits ONE open promise of a kind per family, and a household can have two
-- trips booked. The same wall email_alert_offers (0116) and watched_spots hit.
CREATE TABLE IF NOT EXISTS "family_trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	-- WHOSE mailbox saw it, and whose phone and clock the brief uses. Its own cascade, the
	-- email_alert_offers call (0116): a departed co-parent's trips go with them.
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	-- No FK, deliberately, the same call 0116 makes: a connection is not this row's
	-- lifecycle parent, and disconnecting Gmail must not delete a trip that is still coming.
	"integration_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	-- COARSE BY CONSTRUCTION. A city and at most a region. There is no hotel column, no
	-- address column, no confirmation-number column and no price column, so none of them is
	-- writable -- which is stronger than a redaction step (0116's own argument).
	"destination_city" text NOT NULL,
	"destination_region" text,
	-- LOCAL CALENDAR DAYS, not instants: "the 12th to the 15th" is a wall clock at the
	-- destination, and a timestamptz would render it off the parent's zone. The
	-- family_check_in_notes.noted_on precedent (0118).
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	-- WHY HALE THINKS THE KIDS ARE ON THIS TRIP. A category, never the passenger line.
	-- Only the two values that let Hale speak. There is NO 'none': a booking whose own text
	-- gives no sign the children are on it is not written at all, so a parent's travel dates
	-- for a trip Hale will never mention cannot be stored (PIPEDA purpose limitation), cannot
	-- sit in the due index forever, and cannot reach a co-parent through the rights export.
	-- The miss rate is measured on an enum-only audit row instead (travel_booking_passed_over).
	"child_evidence" text NOT NULL,
	-- THE TERMINAL STATE, replacing a bare `briefed_at`. A trip leaves the working set
	-- exactly ONCE, for a reason that is written down. Without it the two outcomes that are
	-- not a send -- `merged` and `overtaken` -- have nowhere to live, and the sweep must
	-- either re-select closed rows every hour to count them or never count them at all.
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"brief_channel_message_id" uuid REFERENCES "channel_messages"("id") ON DELETE cascade,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_trips_child_evidence_check"
		CHECK ("child_evidence" IN ('named_traveller', 'child_fare')),
	CONSTRAINT "family_trips_dates_check" CHECK ("ends_on" >= "starts_on"),
	CONSTRAINT "family_trips_closed_reason_check"
		CHECK ("closed_reason" IS NULL OR "closed_reason" IN ('sent', 'merged', 'overtaken')),
	CONSTRAINT "family_trips_closed_check"
		CHECK (("closed_at" IS NULL) = ("closed_reason" IS NULL)),
	-- A brief happened and is carried by a message the parent got, or it did not happen.
	-- An `overtaken` trip closes with a NULL message id, which this permits and the other
	-- two reasons require: a trip nobody was told about must never read as one they were.
	--
	-- WRITTEN WITH COALESCE ON PURPOSE: a CHECK that evaluates to NULL *passes* in
	-- Postgres, so the natural `(id IS NOT NULL) = ("closed_reason" IN (...))` is vacuously
	-- true on every open row and enforces nothing. This form is total.
	CONSTRAINT "family_trips_brief_message_check"
		CHECK (("brief_channel_message_id" IS NOT NULL)
			= (COALESCE("closed_reason", '') IN ('sent', 'merged')))
);--> statement-breakpoint

-- One trip per email, as a constraint rather than a convention: a re-fired sweep over a
-- mailbox it has already read conflicts here (0116's own rule).
CREATE UNIQUE INDEX IF NOT EXISTS "family_trips_message_uniq"
	ON "family_trips" ("integration_id", "message_id");--> statement-breakpoint

-- The send sweep's whole working set, and that is TRUE rather than aspirational: every
-- row closes, so the partial index empties.
CREATE INDEX IF NOT EXISTS "family_trips_due_idx"
	ON "family_trips" ("starts_on") WHERE "closed_at" IS NULL;--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The app
-- connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "family_trips" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- The counted category. PROACTIVE_CATEGORY maps to this pg enum, so a new proactive class
-- IS a migration (the 0114/0115/0118/0119 precedent). It ships HERE, one PR ahead of the
-- code that writes it -- the Vercel build beats the Deploy migrate leg by ~60s, and a hot
-- path that reads a value the type does not carry yet 22P02s in the gap.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'travel_brief';

-- BUILDER NOTES:
--  * CREATE TABLE and ENABLE ROW LEVEL SECURITY are UNQUALIFIED on purpose:
--    migration-rls-consistency.test.mjs matches only the unqualified form on both sides.
--  * Every create is IF NOT EXISTS and the ADD VALUE carries IF NOT EXISTS, so a
--    hand-applied migration re-run past the ledger watermark is a no-op rather than a
--    duplicate_table (migration-rerunnable.test.mjs and its pglite double-apply sibling).
--  * The two vocabularies (child_evidence, closed_reason) are TEXT under a CHECK rather
--    than enums, the 0116 call: a vocabulary change never needs an ALTER TYPE in a
--    transaction that also wants to write it. packages/db/scripts/
--    family-trips-vocabulary-consistency.test.mjs is the seam between these CHECK lists
--    and the TypeScript arrays, because SQL cannot import them.
