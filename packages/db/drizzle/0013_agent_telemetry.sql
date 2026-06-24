-- Agent-observability: the coach (ask-hale), digest (daily-brief), inference
-- (infer-memory), and discovery agent call paths record agent_runs rows for
-- cost/latency/model observability. Additive only (rule #9): new agent_name
-- values; existing values unchanged.
ALTER TYPE "public"."agent_name" ADD VALUE 'ask-hale';--> statement-breakpoint
ALTER TYPE "public"."agent_name" ADD VALUE 'daily-brief';--> statement-breakpoint
ALTER TYPE "public"."agent_name" ADD VALUE 'infer-memory';--> statement-breakpoint
ALTER TYPE "public"."agent_name" ADD VALUE 'discovery';
