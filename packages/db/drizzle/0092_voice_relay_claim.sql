-- The row that makes a voice relay ticket single-USE. Additive: one new table, nothing
-- existing is altered.
--
-- WHY IT EXISTS. The relay socket is the one door into Hale that Twilio does not sign,
-- so its authority is a signed ticket in the `wss://` query string. A signature and an
-- expiry prove the ticket is authentic and fresh — they cannot prove this is the first
-- time it has been presented. The url is stored and logged by a third party, so inside
-- the two-minute window a second connect could hand over the same string and be believed,
-- and the session it opened would load a real family's thread.
--
-- WHY A TABLE AND NOT A SET IN MEMORY. Vercel Fluid runs many instances; a replay lands
-- on whichever one answers, which is usually not the one holding the Set. The claim has
-- to be a fact every instance can see, and the unique index below is what makes the
-- INSERT itself the claim — first writer wins, in one atomic statement, exactly like the
-- outbound_sends and rate_limits claims already in this schema.
--
-- NO family_id, NO PII. A CallSid is an opaque provider handle — no number, no name,
-- nothing that reads as a person — and rows are swept after a day (a call is capped at
-- nine minutes), so this table is never a right-to-erasure target. The family-visible
-- half of a refused replay is an audit_log row on the family the ticket named. Rule #1.
CREATE TABLE IF NOT EXISTS "voice_relay_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Twilio's id for the call, globally unique and never reused.
	"call_sid" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- The whole security property, in one line: a second setup for a call that is already
-- claimed loses this index instead of reaching a family.
CREATE UNIQUE INDEX IF NOT EXISTS "voice_relay_claims_call_sid_uniq"
	ON "voice_relay_claims" ("call_sid");--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The
-- app connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "voice_relay_claims" ENABLE ROW LEVEL SECURITY;
