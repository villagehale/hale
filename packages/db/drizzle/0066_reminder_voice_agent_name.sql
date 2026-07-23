-- VIL-229 (LLM voice layer) — reminder-voice agent_runs observability, same as
-- weekly-plan-voice/welcome-voice (0064). Additive only (rule #9): new agent_name
-- value; existing values unchanged. ADD VALUE does not use the new value in this
-- transaction, so it is safe.
ALTER TYPE "public"."agent_name" ADD VALUE 'reminder-voice';
