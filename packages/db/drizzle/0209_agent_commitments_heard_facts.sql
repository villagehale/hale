-- VIL-564 · the schedule facts an activity watch's last follow-up already told the parent,
-- so the next sweep sends only when its research turned up one they have not heard.
-- Additive (rule #9). One nullable column. Re-runnable: IF NOT EXISTS. Reversible:
--   ALTER TABLE agent_commitments DROP COLUMN IF EXISTS heard_facts;

ALTER TABLE "agent_commitments" ADD COLUMN IF NOT EXISTS "heard_facts" text[];
