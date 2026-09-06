-- VIL-337 · WATCHED SPOTS. The course pages a family asked Hale to re-read for a way in.
-- Additive (rule #9): one new table and two new enum values; nothing existing is
-- altered, and an empty table is byte-for-byte today's behaviour.
--
-- WHY A TABLE AND NOT A ROW ON SOMETHING THAT EXISTS. agent_commitments permits ONE open
-- promise of a kind per family, so a household watching two classes cannot be two open
-- rows there. registration_windows is family-agnostic reference data keyed on a CYCLE
-- with no class-level identity, and its cascade would silently delete a parent's watch
-- when a window is retired. So the WATCH is a row here and the PROMISE stays on the
-- ledger: one spot_watch commitment per family, added below.
--
-- Family-scoped with a cascading FK, which IS the erasure path: runDeletionSweep issues
-- one DELETE FROM families and lets the cascade do the rest (rule #1, PIPEDA).
CREATE TABLE IF NOT EXISTS "watched_spots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	-- The recipient the outbound gate is asked about. Its own cascade: a user removed
	-- from a household is a row the family cascade would not collect.
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	-- The page Hale re-reads. Already sanitized when it gets here: https, a registry
	-- host, the one course-page path, and exactly the two query parameters that path
	-- needs. Nothing else in this product sends a parent-supplied URL to the network, so
	-- this column is the whole trust boundary. With the family it is the identity: on
	-- this portal one course page is one registrable event.
	"source_url" text NOT NULL,
	-- What the parent reads back. Through the activity lane's de-identifying gate on the
	-- way in, and refused rather than rewritten if that gate would change it. Never a
	-- household member's name (rule #1).
	"label" text NOT NULL,
	-- The explicit per-watch opt-in to hear at any hour. Read at send time to pick the
	-- proactive CLASS, never to widen one.
	"instant" boolean DEFAULT false NOT NULL,
	-- What the last TRUSTWORTHY read said. Always full or waitlist_full at birth: a watch
	-- is only armed against a page that read that way in the same turn the parent asked.
	-- A page nobody could read is NOT a state here. It is counted in consecutive_failures
	-- and changes nothing, because a page you could not open is not a page that says the
	-- class is full.
	"last_state" text DEFAULT 'full' NOT NULL,
	-- The observation Hale is holding and has not yet been allowed to say. Written by the
	-- transition claim, cleared by a delivery receipt or by the page changing its mind
	-- before the send. Explicit rather than derived, because a reopened waitlist rests in
	-- the same state as a full class and could not be told apart otherwise.
	"pending_kind" text,
	"pending_since" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	-- The transition counter IS the idempotency anchor. Incremented by a guarded update
	-- and carried in the send's dedupe key, so one opening is one text forever, and a
	-- class that fills and frees again is a new key rather than a silenced one.
	"open_transitions" integer DEFAULT 0 NOT NULL,
	-- Transitions the parent was CONFIRMED told about: advanced by a sent or delivered
	-- receipt on the ledger row, never by the carrier merely accepting the message.
	"notified_transitions" integer DEFAULT 0 NOT NULL,
	-- The send claim and the retry bound in one counter: incremented by a guarded update
	-- BEFORE the transport call, carried in the dedupe key, reset by each new transition.
	"send_attempts" integer DEFAULT 0 NOT NULL,
	-- The ledger row of the latest attempt, whose delivery status decides the release.
	-- Text provenance, not a foreign key, on the same reasoning as agent_commitments.
	"notified_message_id" text,
	"last_polled_at" timestamp with time zone,
	-- When this spot may next be read. Carries BACKOFF only: a healthy read leaves it
	-- alone, so a tick that fires late still finds every live spot due.
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- A watch stops being watched. Set at arming time; the sweep releases past it.
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"released_reason" text,
	-- The channel_messages id of the outbound that carried the arming sentence. The same
	-- send-time discipline as agent_commitments.created_from: a watch nobody was told
	-- about is not a watch. Provenance only.
	"created_from" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watched_spots_state_check" CHECK ("last_state" IN ('full', 'waitlist_full', 'open')),
	-- A held observation is named and dated, or it is not held.
	CONSTRAINT "watched_spots_pending_check" CHECK (
		("pending_kind" IS NULL) = ("pending_since" IS NULL)
		AND ("pending_kind" IS NULL OR "pending_kind" IN ('seat_opened', 'waitlist_reopened'))
	),
	-- A release is complete and named, or it did not happen. Half of one is a watch
	-- quietly deleted, which is the one ending a ledger must never allow.
	CONSTRAINT "watched_spots_release_check" CHECK (
		("released_at" IS NULL) = ("released_reason" IS NULL)
		AND ("released_reason" IS NULL OR "released_reason" IN ('notified', 'expired', 'parent_stopped', 'consent_withdrawn', 'unreadable_streak', 'registration_closed', 'delivery_failed', 'send_unconfirmed'))
	),
	-- A confirmation of an opening that never happened is unwritable.
	CONSTRAINT "watched_spots_notify_check" CHECK ("notified_transitions" <= "open_transitions")
);--> statement-breakpoint

-- One LIVE watch per family per course page, as a constraint rather than a convention.
-- It is the insert-as-claim anchor: a parent who asks twice, or a double tick, conflicts
-- here instead of minting a second watch that would text the same phone twice about one
-- seat. PARTIAL, so a released watch stays in history and the same page can be watched
-- again next season.
CREATE UNIQUE INDEX IF NOT EXISTS "watched_spots_live_uniq"
	ON "watched_spots" ("family_id", "source_url")
	WHERE "released_at" IS NULL;--> statement-breakpoint

-- The sweep's whole working set, in the order it spends its budget. Partial, so in a
-- healthy system this index holds only the spots still being watched.
CREATE INDEX IF NOT EXISTS "watched_spots_due_idx"
	ON "watched_spots" ("next_poll_at")
	WHERE "released_at" IS NULL;--> statement-breakpoint

-- Every watch this family ever armed, newest first.
CREATE INDEX IF NOT EXISTS "watched_spots_family_idx"
	ON "watched_spots" ("family_id", "created_at");--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The
-- app connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "watched_spots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- THE PROMISE, not the watch: one open spot_watch per family, because that is what the
-- ledger's partial unique index permits. Distinct from registration_watch, which is the
-- ladder's municipal-morning promise: one household can be owed both, and the index
-- would silently refuse the second if they shared a kind. Opened against the arming ack,
-- kept by a spot-opened text whose receipt landed, cancelled with a named reason when the
-- last live watch ends without one.
ALTER TYPE "public"."agent_commitment_kind" ADD VALUE IF NOT EXISTS 'spot_watch';--> statement-breakpoint

-- Its own outbound category, for the reason every proactive class has one: the gate
-- COUNTS a category, so sharing another class's would spend a budget these texts were
-- never meant to govern. Both proactive kinds (held and instant) count here, so the
-- budget is one budget whatever the hour.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'spot_open';

-- BUILDER NOTES, each verified against packages/db/scripts this turn:
--  * CREATE TABLE and ENABLE ROW LEVEL SECURITY are UNQUALIFIED on purpose:
--    migration-rls-consistency.test.mjs:33-37 matches only the unqualified form on both
--    sides, and a qualified pair captures the literal public as the table name.
--  * ALTER TYPE is schema-qualified on purpose: migration-enum-consistency.test.mjs:22
--    only recognises the qualified CREATE TYPE form and its reference scan runs over RAW
--    sql including comments (:34), matching a quoted word, spaces, then a quoted word, so
--    no comment above puts two double-quoted words next to each other.
--  * Nothing here USES either new enum value: Postgres refuses a value added by ALTER TYPE
--    inside the transaction that adds it, and drizzle wraps each migration in one (the
--    0094 precedent writes no row either).
