-- Soft "done" for a parent-authored plan (additive only, rule #9). Tapping done on
-- a plan STAMPS this column with the moment it was resolved; the plan page then
-- dims / settles a completed plan and the current-week view stops leading with it.
-- NULL = still open. No destructive edit: one nullable column, defaulting to NULL
-- for every existing plan. The done tap itself writes an immutable audit_log row
-- (action_taken 'plan_completed', rule #6) — the column is the read-side state.
ALTER TABLE "family_plans" ADD COLUMN "completed_at" timestamp with time zone;
