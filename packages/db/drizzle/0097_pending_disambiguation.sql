-- VIL-304 · the menu Hale just put in front of a parent, as a row. Additive only
-- (rule #9): one new table. Nothing existing is altered, and an empty table is
-- byte-for-byte today's behaviour — no reply resolves through it until a clarifier has
-- written one.
--
-- WHY A ROW AND NOT A DERIVATION. Every other question in this router is implied by state
-- some module already owns, which is why open-questions.ts refuses to keep a registry.
-- This one is not: "these three options, in this order, numbered, were printed to this
-- parent thirty seconds ago" is a fact about a MESSAGE HALE SENT, and it exists nowhere
-- else. On 2026-08-24 a parent quoted one of those options back verbatim and reached the
-- general coach lane, which told them Hale cannot message other families. The option was
-- real and the answer was exact; there was simply nowhere for it to land.
--
-- IT DOES NOT SAY WHETHER ANYTHING IS STILL OPEN, deliberately. That question keeps its
-- one reader (the module that owns each kind) and the matcher re-asks it on the way past,
-- so this table can never disagree with the ledgers about what is outstanding.
--
-- RULE #1: `options` holds the phrases Hale itself printed — an action TYPE label, "the
-- plan I offered" — which is what the parent already read on their phone. No payload, no
-- other household, and never the parent's own words.
CREATE TABLE IF NOT EXISTS "pending_disambiguations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	-- Per PARENT, not per family: two parents share every open question and answer them in
	-- two separate threads, so a co-parent's "the second one" must never be read against a
	-- list the other parent was shown. Its own cascade, because a user removed from a
	-- household is a row the family cascade would not collect.
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	-- The channel_messages row that carried the question. NOT NULL is the send-time
	-- discipline: a clarifier that never reached a transport asked nobody anything, so it
	-- may not bind the next reply.
	"asked_from" text NOT NULL,
	-- The yes or no the parent had ALREADY given. The clarifier asks WHICH, never WHETHER,
	-- and re-deciding the polarity off a reply that only names a target would turn "no
	-- thanks" plus "the calendar one" into a calendar write nobody consented to (rule #4).
	"polarity" text NOT NULL,
	-- Whether the sentence that went out actually printed 1, 2, 3. An ordinal is only an
	-- answer to a list the parent was shown.
	"numbered" boolean NOT NULL,
	-- The options as printed, in printed order. The ordinal is the array position.
	"options" jsonb NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Stamped by the next inbound whatever it says. One shot.
	"consumed_at" timestamp with time zone,
	CONSTRAINT "pending_disambiguations_polarity_check" CHECK ("polarity" IN ('yes', 'no'))
);--> statement-breakpoint

-- AT MOST ONE live menu per parent, and the supersede anchor with it: a second clarifier
-- conflicts here and takes the row over, rather than leaving two lists a single reply
-- could be read against.
CREATE UNIQUE INDEX IF NOT EXISTS "pending_disambiguations_live_uniq"
	ON "pending_disambiguations" ("parent_user_id")
	WHERE "consumed_at" IS NULL;--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The app
-- connects as postgres (BYPASSRLS) and reads this server-side. Rule #1.
ALTER TABLE "pending_disambiguations" ENABLE ROW LEVEL SECURITY;
