-- Prompt-cache tokens per run. NULL = not measured by this writer. Additive (rule #9).
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "cache_write_tokens" integer;
