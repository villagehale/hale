-- What the calendar alert last KNEW about one event on one connection (#650 follow-ups).
-- Additive (rule #9): one new table, nothing existing altered, and an empty table is
-- byte-for-byte today's behaviour.
--
-- ONE primitive for three follow-ups, because all three were the same missing memory. The
-- connector sweep is a delta reader: events.list hands a change over once and the syncToken
-- advances past it the same instant, so anything the alert could not answer from a single
-- change in isolation could not be answered at all. It moved (needs the OLD start). It is
-- one edit to a weekly class arriving as six instance changes (needs recurring_event_id to
-- group on). It was refused by quiet hours and will never be offered again (needs a note
-- that Hale still owes the text).
--
-- WHAT IT MAY HOLD (rule #1). The description and the attendee list never enter Hale at
-- all. This table holds the SHAPE of an event, plus - only while a text is owed - the two
-- strings the renderer had already decided it was willing to say out loud. Cleared the
-- moment the hold resolves, so the steady state carries no parent words.
--
-- Keyed on the CONNECTION, not the family: two parents who both connect a calendar are two
-- integrations with two independent memories, and the cascade below IS the erasure path
-- (integrations already cascades from families).
CREATE TABLE IF NOT EXISTS "calendar_event_snapshots" (
	"integration_id" uuid NOT NULL REFERENCES "integrations"("id") ON DELETE cascade,
	-- Google's id for this event or, with singleEvents=true, for this INSTANCE.
	"event_id" text NOT NULL,
	-- The series this instance belongs to, or null for a one-off.
	"recurring_event_id" text,
	-- The start Hale last SAW, which is what makes the next sighting a MOVE rather than a
	-- first sight. Not always the start the parent was told: while a text is owed this is
	-- the held (untold) one, and `held_moved_from_at` is what they last heard.
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"all_day" boolean DEFAULT false NOT NULL,
	-- Google's `updated`, or the etag the sync fell back to, at the last sighting.
	"updated_stamp" text NOT NULL,
	"status" text NOT NULL,
	-- Set when a change was held by the outbound gate or the per-sweep cap, kept at its
	-- ORIGINAL instant across later holds so re-offers go out in the order they were owed.
	"pending_since" timestamp with time zone,
	-- Everything a re-offer needs to say the same sentence again, and the only
	-- parent-authored content here: the clamped title and the vetted location the renderer
	-- already passed for sending, plus the start the held text said the event moved FROM
	-- and whether THAT start was an all-day one (both null when the held text was not
	-- about a move). All of them are null unless a text is owed.
	"held_title" text,
	"held_location" text,
	"held_moved_from_at" timestamp with time zone,
	"held_moved_from_all_day" boolean,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_snapshots_integration_id_event_id_pk" PRIMARY KEY ("integration_id", "event_id"),
	-- A hold is complete - dated, placed in time, and named - or it is not a hold. Half of
	-- one is either a text nobody can re-render or a parent's title kept for no reason, and
	-- the second is the ending rule #1 must not allow.
	CONSTRAINT "calendar_event_snapshots_held_check" CHECK (
		("pending_since" IS NOT NULL AND "start_at" IS NOT NULL AND "held_title" IS NOT NULL)
		OR (
			"pending_since" IS NULL AND "held_title" IS NULL
			AND "held_location" IS NULL AND "held_moved_from_at" IS NULL
		)
	),
	-- The old start and its shape are ONE fact in two columns. An instant with no shape is
	-- what makes a re-offered "it used to be all day" come back out as "(was 12:00)" - a
	-- clock read off a local midnight that the calendar never had.
	CONSTRAINT "calendar_event_snapshots_moved_from_check" CHECK (
		("held_moved_from_at" IS NULL) = ("held_moved_from_all_day" IS NULL)
	)
);--> statement-breakpoint

-- The re-offer's whole working set, in the order it owes them. Partial, so in a healthy
-- system this index holds nothing at all.
CREATE INDEX IF NOT EXISTS "calendar_event_snapshots_pending_idx"
	ON "calendar_event_snapshots" ("integration_id", "pending_since")
	WHERE "pending_since" IS NOT NULL;--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The app
-- connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "calendar_event_snapshots" ENABLE ROW LEVEL SECURITY;
