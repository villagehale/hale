-- VIL-352 rung 3a · the forwarding door. Additive (rule #9); every statement re-runnable,
-- because the Deploy migrate leg re-runs every file past the ledger watermark.

-- THE FAMILY'S FORWARDING CREDENTIAL, and a SEPARATE secret from ics_share_token on the
-- same table: revoking a forwarding address must not also kill every calendar link the
-- family holds, and revoking the calendar feed must not silently stop their mail being
-- read. Nulling it revokes the address, the revokeIcsToken shape. Lowercase hex, because
-- the inbound parser lowercases every address it sees, so a mixed-case secret is a secret
-- that can never match itself.
ALTER TABLE "families"
	ADD COLUMN IF NOT EXISTS "inbound_forward_token" text;--> statement-breakpoint

-- A unique INDEX rather than the ADD CONSTRAINT the 0062 ics token used: past the
-- watermark a bare ADD CONSTRAINT raises duplicate_table on the second apply.
CREATE UNIQUE INDEX IF NOT EXISTS "families_inbound_forward_token_uniq"
	ON "families" ("inbound_forward_token");--> statement-breakpoint

-- THE ALLOWLIST: one row per family and original-sender domain. This is the ROUTING
-- projection the hot path reads; consent_records stays the legal record of the YES. Two
-- stores on purpose, the split the SMS door already argues for -- gate on live state,
-- never on the append-only ledger.
--
-- The state column is text under an inline CHECK, not an enum: three values, an enum
-- value can never be dropped, and an inline CHECK inside CREATE TABLE IF NOT EXISTS is
-- re-runnable while a bare ALTER TABLE ADD CONSTRAINT is not (the 0116 precedent).
CREATE TABLE IF NOT EXISTS "family_forward_senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	-- The original sender's domain, lowercased. The allowlist key: a family says yes to a
	-- school, not to one address at it.
	"sender_domain" text NOT NULL,
	-- The per-sender sub-tag that addresses the ask. 8 lowercase hex characters, which is
	-- what makes a bare YES unambiguous without an open-question row: the reply address
	-- names the sender it is about.
	"ref" text NOT NULL,
	"state" text NOT NULL,
	-- WHO decided, when there was a decision. Its own SET NULL rather than a cascade: a
	-- parent leaving the household does not un-decide what the household decided.
	"decided_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- A decision is named and dated, or it has not happened. Half of one is a sender the
	-- hot path would read as settled with nothing behind it.
	CONSTRAINT "family_forward_senders_state_check" CHECK (
		"state" IN ('pending', 'allowed', 'blocked')
		AND ("state" = 'pending') = ("decided_at" IS NULL)
	)
);--> statement-breakpoint

-- One decision per family and domain, as a constraint rather than a convention: a second
-- forward from the same school conflicts here instead of minting a second question.
CREATE UNIQUE INDEX IF NOT EXISTS "family_forward_senders_domain_uniq"
	ON "family_forward_senders" ("family_id","sender_domain");--> statement-breakpoint

-- The ref is the credential the ask hands out, so it resolves to at most one sender.
CREATE UNIQUE INDEX IF NOT EXISTS "family_forward_senders_ref_uniq"
	ON "family_forward_senders" ("family_id","ref");--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The app
-- connects as postgres with BYPASSRLS and reads these server-side. Rule #1.
ALTER TABLE "family_forward_senders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- THE RAW, and the only place it is ever stored. A forward sits here exactly while a
-- decision is pending; allow, block, or the 72h lapse each delete it. Once reading is
-- permitted nothing is stored at all -- the body lives in the extraction call's stack
-- frame. Plaintext, on the same terms as an inbound channel_messages body: no weaker, and
-- the difference from that ledger is lifetime, not exposure.
CREATE TABLE IF NOT EXISTS "email_forwards_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"sender_id" uuid NOT NULL REFERENCES "family_forward_senders"("id") ON DELETE cascade,
	"provider_message_id" text NOT NULL,
	"original_from" text NOT NULL,
	"subject" text NOT NULL,
	"raw_body" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- One held forward per message, belt and braces beside the channel_messages claim.
CREATE UNIQUE INDEX IF NOT EXISTS "email_forwards_pending_provider_msg_uniq"
	ON "email_forwards_pending" ("provider_message_id");--> statement-breakpoint

-- The sweep's whole working set: the oldest held forwards first.
CREATE INDEX IF NOT EXISTS "email_forwards_pending_created_idx"
	ON "email_forwards_pending" ("created_at");--> statement-breakpoint

ALTER TABLE "email_forwards_pending" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- The ledger lane. Its own category, not reply, so an answer to a forwarded document
-- never reads as a reply to the parent's own words in a PIPEDA access read.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'forwarded_mail';
