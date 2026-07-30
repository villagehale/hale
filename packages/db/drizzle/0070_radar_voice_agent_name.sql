-- VIL-238 (M3 radar payload composer) — radar-voice agent_runs observability, the same
-- additive shape as reminder-voice (0066) and the earlier voice stages (0064). Additive
-- only (rule #9): a new agent_name value; existing values unchanged. ADD VALUE does not
-- use the new value in this transaction, so it is safe.
ALTER TYPE "public"."agent_name" ADD VALUE 'radar-voice';
