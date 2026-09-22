-- Instinct-style memory v1. Additive only (rule #9): two new tables, no changes to
-- family_memory_facts. Aliases are a derived index. Digests are count rollups with a
-- stable (family, grain, local period) identity so a retry refreshes instead of
-- duplicating. Neither table stores a message body.
--
-- BUILDER NOTES:
--  * CREATE TABLE and ENABLE ROW LEVEL SECURITY are unqualified on purpose
--    (migration-rls-consistency.test.mjs).
--  * IF NOT EXISTS so a re-run past the ledger watermark is a no-op
--    (migration-rerunnable.test.mjs).
CREATE TABLE IF NOT EXISTS "family_memory_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"fact_id" uuid NOT NULL REFERENCES "family_memory_facts"("id") ON DELETE cascade,
	"alias_norm" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_memory_aliases_source_check" CHECK ("source" IN ('key', 'lexicon')),
	CONSTRAINT "family_memory_aliases_norm_check" CHECK ("alias_norm" ~ '^[a-z0-9]+$')
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "family_memory_aliases_fact_alias_uniq"
	ON "family_memory_aliases" ("fact_id", "alias_norm");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "family_memory_aliases_lookup_idx"
	ON "family_memory_aliases" ("family_id", "alias_norm");--> statement-breakpoint

ALTER TABLE "family_memory_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "family_memory_digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"grain" text NOT NULL,
	"period_start" date NOT NULL,
	"timezone" text NOT NULL,
	"summary" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"source_count" integer NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_memory_digests_grain_check" CHECK ("grain" IN ('day', 'week'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "family_memory_digests_identity_uniq"
	ON "family_memory_digests" ("family_id", "grain", "period_start");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "family_memory_digests_family_idx"
	ON "family_memory_digests" ("family_id", "grain", "period_start");--> statement-breakpoint

ALTER TABLE "family_memory_digests" ENABLE ROW LEVEL SECURITY;
