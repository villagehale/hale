-- VIL-558 · a plan's run outlives one sweep. A queue at the open can take longer than the
-- cron route may run (800 s), so a sweep that reaches its budget checkpoints the plan
-- instead of cancelling it: the offer stays `submitting`, keeps its Browser Use run (and so
-- its place in the town's queue), and the next sweep resumes it.
--
-- plan_resume: Browser Use run, session and browser ids, the phase, and at checkout the
-- choice rank and cart total. Never a person, a link or a card.
-- plan_lease_until: the sweep carrying the plan holds it until then; a sweep the platform
-- killed lets go when it passes.
-- plan_cancel_requested_at: the parent took the plan back while its run was going. The next
-- sweep lets the run go instead of resuming it, and no payment starts after it.
-- Additive (rule #9). Nullable, no default. Re-runnable: IF NOT EXISTS. Reversible:
--   ALTER TABLE authorized_signup_offers DROP COLUMN IF EXISTS plan_cancel_requested_at;
--   ALTER TABLE authorized_signup_offers DROP COLUMN IF EXISTS plan_lease_until;
--   ALTER TABLE authorized_signup_offers DROP COLUMN IF EXISTS plan_resume;
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "plan_resume" jsonb;
--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "plan_lease_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "plan_cancel_requested_at" timestamp with time zone;
