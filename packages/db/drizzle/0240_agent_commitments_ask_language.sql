-- The language tag the inbound screen read off the parent's text an activity promise
-- answers, so the follow-up is written in the language they asked in. A tag, never the
-- parent's words. Null when the screen read none, on every other kind, and on rows
-- written before this column existed.
-- Add-only and nullable (rule #9). Re-runnable. Reversible:
--   ALTER TABLE "agent_commitments" DROP COLUMN IF EXISTS "ask_language";
ALTER TABLE "agent_commitments" ADD COLUMN IF NOT EXISTS "ask_language" text;
