-- The founder's welcome note — a family arrives from an EarlyON poster, Hale pings the
-- founder, and his YES sends a note in his own voice into that family's thread.
-- Additive only (rule #9): two enum values and one nullable column. Nothing existing is
-- altered, and on an unmigrated database every statement here is a no-op.
--
-- WHY THE PING NEEDS A ROW. It ASKS something ("Reply YES and I'll send them your
-- welcome note"), and on this product a question that lives only as prose inside a sent
-- SMS is a question the reply resolver cannot see — which is how, on 2026-08-20, a
-- parent's acceptance of a health offer was read against two unrelated standing
-- questions instead. The offer-is-a-proposal doctrine is that every ask registers itself
-- on the MEM-10 open-loops ledger at SEND TIME, in the same flow as the send, so the YES
-- resolves through the same primitives every other answer does.
ALTER TYPE "public"."agent_commitment_kind" ADD VALUE IF NOT EXISTS 'founder_welcome_offer';--> statement-breakpoint

-- Both directions of the founder's own voice: the ping to him, and the note to the new
-- family. Its own category for the reason every class here has one — the category is
-- what a PIPEDA right-to-access read renders as WHY a message exists, and "a person, not
-- the product, wrote to you" is not something any existing class says.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'founder';--> statement-breakpoint

-- WHICH OTHER HOUSEHOLD an offer is about. Every commitment before this one is owed to
-- the family it names; this is the first whose subject and whose creditor are different
-- households — made to the founder, kept by texting somebody else. `ON DELETE SET NULL`
-- mirrors `subject_child_id`: a family erased between the ping and the YES leaves an
-- offer pointing at nobody, which the reply reads as a named refusal to send, rather
-- than a dangling id resolving to a household that no longer exists.
ALTER TABLE "agent_commitments" ADD COLUMN IF NOT EXISTS "subject_family_id" uuid REFERENCES "public"."families"("id") ON DELETE SET NULL;
