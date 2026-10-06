-- family_memory_aliases and family_memory_digests, applied where 0127 cannot run.
--
-- 0127_instinct_memory already creates these tables. Production's watermark moved
-- past that file without recording its hash or its `when`, so drizzle migrate
-- will not run it. The digest cron and the memory brief select family_memory_digests
-- today. This file is the same additive DDL with a later `when` (after
-- 0154_family_events_placed_google_event's 1781469648000).
--
-- Additive (rule #9). Re-runnable: CREATE TABLE/INDEX IF NOT EXISTS, ENABLE ROW
-- LEVEL SECURITY (a no-op the second time), and the checks inside a
-- duplicate-object guard. A database that already applied 0127 no-ops.
--
-- The ledger gate accepts 0127's missing hash only after THIS file's hash is in
-- drizzle.__drizzle_migrations (ledger-exemptions.json superseded_by). Do not
-- insert a ledger row for 0127 by hand.

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

DO $$ BEGIN
  ALTER TABLE "family_memory_aliases"
    ADD CONSTRAINT "family_memory_aliases_source_check"
    CHECK ("source" IN ('key', 'lexicon'));
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_memory_aliases"
    ADD CONSTRAINT "family_memory_aliases_norm_check"
    CHECK ("alias_norm" ~ '^[a-z0-9]+$');
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

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

ALTER TABLE "family_memory_digests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_memory_digests"
    ADD CONSTRAINT "family_memory_digests_grain_check"
    CHECK ("grain" IN ('day', 'week'));
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;
