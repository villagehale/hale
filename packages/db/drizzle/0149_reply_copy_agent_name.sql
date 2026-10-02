-- Model-written duty and family-memory replies record cost on agent_runs.
-- Additive only (rule #9): a new agent_name value; existing values unchanged.
ALTER TYPE "public"."agent_name" ADD VALUE IF NOT EXISTS 'reply-copy';
