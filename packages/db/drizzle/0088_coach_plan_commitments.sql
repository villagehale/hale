-- Full coaching plans — the offer, the plan, the check-in — carried on the MEM-10
-- open-loops ledger rather than on a table of their own. Additive only (rule #9):
-- three new enum values and one nullable column. Nothing existing is altered, and on
-- an unmigrated database every statement here is a no-op.
--
-- WHY THE LEDGER AND NOT A NEW TABLE. An offer ("want the full plan? reply YES") and a
-- follow-up ("how did the first few nights go?") are both promises with a clock on
-- them, which is precisely what agent_commitments already models — including the one
-- property this arc depends on: the partial unique index means a family has at most
-- ONE open plan offer, so a bare YES resolves without a correlation id.

ALTER TYPE "public"."agent_commitment_kind" ADD VALUE IF NOT EXISTS 'plan_offer';--> statement-breakpoint
ALTER TYPE "public"."agent_commitment_kind" ADD VALUE IF NOT EXISTS 'plan_check_in';--> statement-breakpoint

-- The check-in is a PROACTIVE send, so the outbound gate counts it — and the gate
-- counts by channel_messages.category. Its own class so a family's coaching volume can
-- never spend the weekly nudge budget, nor read as spent by it.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'plan_check_in';--> statement-breakpoint

-- WHICH plan. A member of the closed PlanTopic vocabulary, never free text and never a
-- parent's words, so this column carries a category rather than content (rule #1).
-- Nullable: the two original kinds have no subject — one first find, one registration
-- plan — while a plan offer's fulfilment needs to know what was offered.
ALTER TABLE "agent_commitments" ADD COLUMN IF NOT EXISTS "topic" text;--> statement-breakpoint

-- WHOSE plan. A real foreign key, unlike created_from, because this id is FUNCTIONAL:
-- the plan composer looks the child up to ground on their age, and a 6-month plan and
-- an 18-month plan for the same topic are different plans. ON DELETE SET NULL so a
-- child removed between the offer and the YES leaves a household-scoped plan rather
-- than a dangling lookup.
ALTER TABLE "agent_commitments"
	ADD COLUMN IF NOT EXISTS "subject_child_id" uuid REFERENCES "children"("id") ON DELETE SET NULL;
