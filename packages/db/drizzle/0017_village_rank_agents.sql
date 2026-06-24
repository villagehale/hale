-- Village-home: the agent-ranked feed (rank-recommendations) and the curated
-- shortlist (curate-shortlist) record agent_runs rows for cost/latency/model
-- observability, exactly like the other agent paths. Additive only (rule #9):
-- new agent_name values; existing values unchanged.
ALTER TYPE "public"."agent_name" ADD VALUE 'rank-recommendations';--> statement-breakpoint
ALTER TYPE "public"."agent_name" ADD VALUE 'curate-shortlist';
