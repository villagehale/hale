-- Insert-as-claim for the read-then-act seams the SMS reliability audit named (P1-4).
-- Additive only (rule #9): two indexes, one column, one table. Nothing existing changes
-- shape, default, or nullability.
--
-- THE DEFECT SHAPE, once, because all three objects below close instances of it: an
-- "already done?" check that is a SELECT followed by an act is decided by application
-- timing, and every one of these seams sits behind at-least-once delivery (pg-boss
-- expiry redelivery, Twilio 15s-budget resends, duplicate producer jobs) where two
-- executions legitimately overlap. Both pass the SELECT, both act. The repo already
-- holds the cure three times over — the 0085 hand-off claim, outbound_sends, and the
-- voice relay claim — and relay-claim.ts's comment states the rule: the INSERT is the
-- claim; the unique index decides, atomically, where concurrency is actually decided.

-- ── 1. The turn ledger's ANSWERED write becomes a claim ──────────────────────────────
--
-- The router's re-drive gate (wiring.ts auditTurnLedger) reads audit_log for a
-- 'sms_turn_answered' row and the writer inserts one unconditionally — so two consumers
-- of the same redelivered turn both read 'fresh' and both answer, and history shows two
-- clean answers. The arbiter CANNOT live on audit_log itself: that table is append-only
-- and immutable (rule #6), so if the race has already written duplicate answered rows
-- the 0085 remedy — keep the earliest, delete the rest — is unavailable, and a unique
-- index over it could refuse to build in production. So the claim gets its own row,
-- exactly as the voice relay's did: the writer inserts the claim AND the audit row in
-- one transaction, the unique index below decides the winner, and the loser writes
-- nothing and reports 'already_answered' (a named outcome, rule #11). audit_log stays
-- pure history; this table is the lock beside it. Rows age out with the ledger's own
-- 7-day lookback — the exactly-once property is the index's, never the sweep's.
CREATE TABLE IF NOT EXISTS "channel_turn_answer_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_message_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "channel_turn_answer_claims_message_uniq"
  ON "public"."channel_turn_answer_claims" ("channel_message_id");
--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The
-- app connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "channel_turn_answer_claims" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── 2. A calendar placement claims its action ────────────────────────────────────────
--
-- addToCalendar's idempotency was a SELECT of audit_log (priorPlacementEventId) with no
-- constraint behind it — the one executor path that skipped the outbound_sends idiom, as
-- its own neighbor's comment ("the idempotency gate") shows it knew to use. Two
-- concurrent deliveries of one calendar_add both saw no prior row, both inserted, and
-- the family calendar showed the same activity twice with two invite emails. The column
-- stamps WHICH action placed a row; the partial unique index makes the second insert the
-- loser, atomically. NULL stays legal: parent-authored and email-sourced family_events
-- rows are placed by no action at all.
ALTER TABLE "public"."family_events"
  ADD COLUMN IF NOT EXISTS "placed_by_action_id" uuid;
--> statement-breakpoint

-- Backfill from the audit trail so a REDELIVERY of a pre-migration placement action
-- conflicts with the row it already placed instead of placing a second one: the success
-- audit stamped the family_events id as target_id and the action id in `after`.
-- Deliberately skips any action the race already double-placed (two audit rows naming
-- different target rows) — stamping both would refuse the index below; those rows stay
-- NULL, visible, and listed by:
--   SELECT after->>'actionId', count(DISTINCT target_id) FROM audit_log
--   WHERE action_taken = 'action.calendar_placed'
--   GROUP BY 1 HAVING count(DISTINCT target_id) > 1;
UPDATE "public"."family_events" fe
SET "placed_by_action_id" = (a."after"->>'actionId')::uuid
FROM "public"."audit_log" a
WHERE a."action_taken" = 'action.calendar_placed'
  AND a."target_id" = fe."id"::text
  AND a."after"->>'actionId' IS NOT NULL
  AND fe."placed_by_action_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "public"."audit_log" a2
    WHERE a2."action_taken" = 'action.calendar_placed'
      AND a2."after"->>'actionId' = a."after"->>'actionId'
      AND a2."target_id" IS DISTINCT FROM a."target_id"
  );
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "family_events_placed_by_action_uniq"
  ON "public"."family_events" ("placed_by_action_id")
  WHERE "placed_by_action_id" IS NOT NULL;
--> statement-breakpoint

-- ── 3. The intake turn claim ─────────────────────────────────────────────────────────
--
-- The intake machine's duplicate check was `session.lastProviderId === providerId` — a
-- value saved only AFTER the turn's model calls and sends, so a Twilio 15s-budget resend
-- arriving mid-turn passed it and ran the whole turn again (two welcome texts, doubled
-- extractor spend, last-write-wins session clobber — the exact resend race migration
-- 0085's comment records firing in production for the post-intake leg). Pre-provisioning
-- sessions write NO channel_messages row (no family exists yet), so the 0085 index
-- cannot arbitrate the early funnel; this table is that claim's home. It also remembers
-- EVERY provider id in its retention window, closing the lastProviderId gap where a
-- delayed redelivery of message A after message B was processed re-answered A.
--
-- Family-AGNOSTIC ops data, the voice_relay_claims precedent exactly: a MessageSid is an
-- opaque provider handle with no number, no name, and no family in it, and rows age out
-- in a day (the claim path deletes as it claims). Nothing here is reachable by, or in
-- need of, a right-to-erasure sweep. Rule #1.
--
-- completed_at is rule #11's half: a claim whose turn crashed before finishing leaves
-- claimed_at set and completed_at NULL — a visible residue, never a silent one. The
-- deliberate trade (documented at the claim site): a redelivery during a crashed turn is
-- refused as 'duplicate', which loses the self-heal the old racy check accidentally
-- provided; the window is the seconds of a deterministic turn, against a resend race
-- that is firing in production today.
CREATE TABLE IF NOT EXISTS "sms_intake_turn_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_message_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "sms_intake_turn_claims_provider_msg_uniq"
  ON "public"."sms_intake_turn_claims" ("provider_message_id");
--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The
-- app connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "sms_intake_turn_claims" ENABLE ROW LEVEL SECURITY;
