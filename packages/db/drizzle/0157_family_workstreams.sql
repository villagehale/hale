-- VIL-419 — active workstreams. A thread Hale is in the middle of for one
-- family (a search, a wait, a reminder, a comparison). Separate from
-- family_memory_facts: identity, obligation, and curiosity stay on that table.
-- A declined activity is stored as dropped, never as a confirmed plan.
--
-- Journal when is 1781469750000, after 0156_family_events_placed_google_event
-- (1781469700000). Drizzle applies a file only when `when` is above the
-- ledger watermark.
--
-- Additive (rule #9). Reversible:
--   DROP TABLE IF EXISTS family_workstreams;
-- Re-runnable: CREATE TABLE IF NOT EXISTS. Nothing existing is altered.

CREATE TABLE IF NOT EXISTS "family_workstreams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "status" text NOT NULL,
  "next_step" text,
  "check_back_at" timestamp with time zone,
  "child_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "event_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "activity_refs" text[] DEFAULT '{}'::text[] NOT NULL,
  "created_from" text NOT NULL,
  "updated_from" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone,
  "last_followed_up_at" timestamp with time zone,
  CONSTRAINT "family_workstreams_status_chk"
    CHECK ("status" IN (
      'open',
      'waiting_on_parent',
      'waiting_on_third_party',
      'scheduled',
      'done',
      'dropped'
    )),
  CONSTRAINT "family_workstreams_title_chk"
    CHECK (char_length("title") BETWEEN 1 AND 160),
  CONSTRAINT "family_workstreams_next_step_chk"
    CHECK ("next_step" IS NULL OR char_length("next_step") <= 240)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "family_workstreams_open_idx"
  ON "family_workstreams" ("family_id", "updated_at")
  WHERE "status" IN (
    'open',
    'waiting_on_parent',
    'waiting_on_third_party',
    'scheduled'
  );--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "family_workstreams_check_back_idx"
  ON "family_workstreams" ("check_back_at")
  WHERE "check_back_at" IS NOT NULL
    AND "status" IN (
      'open',
      'waiting_on_parent',
      'waiting_on_third_party',
      'scheduled'
    );--> statement-breakpoint
ALTER TABLE "family_workstreams" ENABLE ROW LEVEL SECURITY;
