-- week_plans: one composed weekly plan per family per week (VIL-217 — "the Sunday
-- brain"). Additive only (rule #9). The composer runs Saturday night family-local and
-- writes the UPCOMING week's plan; `week_start` is that week's Monday as a family-local
-- calendar date. The unique (family_id, week_start) index makes a recompose upsert the
-- same row (idempotent) rather than duplicate it.
--
-- `summary` (the one-sentence LLM week summary) is NULLABLE by design: the deterministic
-- composer persists the full `items` plan even when the agent step is disabled or fails
-- (graceful degradation, rule #8). `items` defaults to an empty array so an empty week
-- is a real, queryable artifact, never a null. Channel-agnostic — B2 renders it, B3 acts
-- on it.
CREATE TABLE "week_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"composed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'composed' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "week_plans" ADD CONSTRAINT "week_plans_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Idempotent recompose: one plan per family per covered week.
CREATE UNIQUE INDEX "week_plans_family_week_idx" ON "week_plans" USING btree ("family_id","week_start");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The
-- app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "week_plans" ENABLE ROW LEVEL SECURITY;
