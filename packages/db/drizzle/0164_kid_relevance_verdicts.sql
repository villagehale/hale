-- VIL-226 / VIL-403 — one AI verdict per connector item: is this about the kids?
-- Additive (rule #9). Reversible: ALTER TABLE family_events DROP COLUMN IF EXISTS
-- kid_verdict_id; DROP TABLE IF EXISTS kid_relevance_verdicts;
-- Re-runnable: CREATE TABLE / INDEX use IF NOT EXISTS, the CHECKs live inside CREATE
-- TABLE, and ADD COLUMN IF NOT EXISTS skips its foreign key on a second pass. RLS with
-- no policy denies the anon Data API; the app connects as postgres (BYPASSRLS).
--
-- What this table may hold (rule #1). Never a title, a place or a sender: the item is
-- named only by its connector key. `reason` is the model's one-line why, kept only for
-- a non-teen kid verdict, so a parent's own appointment and a teenager's item leave no
-- words behind. A parent's "that's mine" is a `parent` row and a model re-judge never
-- overwrites it. The family cascade is the erasure path.
CREATE TABLE IF NOT EXISTS "kid_relevance_verdicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "source" text NOT NULL,
  "integration_id" uuid REFERENCES "integrations"("id") ON DELETE cascade,
  "item_key" text NOT NULL,
  "input_hash" text NOT NULL,
  "verdict" text NOT NULL,
  "child_id" uuid REFERENCES "children"("id") ON DELETE set null,
  "teen" boolean NOT NULL DEFAULT false,
  "reason" text,
  "decided_by" text NOT NULL,
  "model" text,
  "skill_hash" text,
  "decided_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "kid_relevance_verdicts_source_chk" CHECK ("source" IN ('google_calendar', 'gmail', 'group')),
  CONSTRAINT "kid_relevance_verdicts_verdict_chk" CHECK ("verdict" IN ('kid', 'adult', 'unsure')),
  CONSTRAINT "kid_relevance_verdicts_decided_by_chk" CHECK ("decided_by" IN ('model', 'parent')),
  CONSTRAINT "kid_relevance_verdicts_reason_chk" CHECK (
    "reason" IS NULL OR ("verdict" = 'kid' AND NOT "teen")
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kid_relevance_verdicts_item_uniq"
  ON "kid_relevance_verdicts" ("family_id", "source", "integration_id", "item_key") NULLS NOT DISTINCT;--> statement-breakpoint
ALTER TABLE "kid_relevance_verdicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "kid_verdict_id" uuid
  REFERENCES "kid_relevance_verdicts"("id") ON DELETE set null;
