-- VIL-229 (LLM voice layer) — the model-composed voice stages (weekly plan, welcome)
-- record agent_runs rows for cost/latency/model observability, exactly like every
-- other agent path. Additive only (rule #9): new agent_name values; existing values
-- unchanged. ADD VALUE does not use the new value in this transaction, so it is safe.
ALTER TYPE "public"."agent_name" ADD VALUE 'weekly-plan-voice';--> statement-breakpoint
ALTER TYPE "public"."agent_name" ADD VALUE 'welcome-voice';
