-- The activity follow-up — Hale's "I'll come back to you" about an activity search,
-- carried on the MEM-10 open-loops ledger. Additive only (rule #9): two new enum
-- values. Nothing existing is altered, and on an unmigrated database every statement
-- here is a no-op.
--
-- WHY IT NEEDS A ROW. On 2026-08-20 a parent asked what their toddler could do between
-- September and December. Hale had nothing offerable, named nothing, and said "I'll
-- come back to you on it." Nothing was written down, so no sweep could select the
-- family, and no digest could count the debt: the promise existed only as prose inside
-- a sent SMS, in a product whose transcript is going to be compacted. Every other
-- promise Hale makes is a row (first_find, registration_plan, plan_offer,
-- plan_check_in, checkup_offer); this was the last shape of promise with nothing behind
-- it.
--
-- `topic` carries the SEARCH SUBJECT this promise is about — the de-identified activity
-- phrase the coach searched on ("toddler gymnastics", "fall swim lessons"), never a
-- child's name and never a parent's raw words. It is what the sweep re-runs the lane
-- on, which is why it is stored rather than recovered from `created_from` (provenance
-- only). `subject_child_id` carries whose search it was, or NULL for a household one.
ALTER TYPE "public"."agent_commitment_kind" ADD VALUE IF NOT EXISTS 'activity_followup';--> statement-breakpoint

-- The kept promise is a PROACTIVE send, so the outbound gate counts it — and the gate
-- counts by channel_messages.category. Its own class for the reason every proactive
-- class has one: folding it into 'followup' would put a promise Hale OWES inside the
-- budget for a check-in Hale CHOSE to send, and a family who asked for one would lose
-- it to a question about last week.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'activity_followup';
