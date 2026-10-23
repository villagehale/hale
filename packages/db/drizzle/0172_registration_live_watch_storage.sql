-- VIL-423 step 2: URL-owned watches may exist before dates are published.
-- Existing rows, approval actions, results and message dedupe keys are preserved.
-- The legacy window association remains until the readers are migrated off it.
ALTER TABLE "registration_sequences" ALTER COLUMN "window_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "registration_sequences"
  ADD COLUMN IF NOT EXISTS "child_id" uuid REFERENCES "children"("id") ON DELETE set null,
  ADD COLUMN IF NOT EXISTS "last_reading" jsonb,
  ADD COLUMN IF NOT EXISTS "last_read_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "next_check_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "pending_change" jsonb,
  ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "date_review_action_id" uuid REFERENCES "actions"("id") ON DELETE set null;
--> statement-breakpoint
-- Keep the old constraint names so replaying 0110/0111 cannot reinstate their limits.
ALTER TABLE "registration_sequences" DROP CONSTRAINT IF EXISTS "registration_sequences_course_check";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "registration_sequences" ADD CONSTRAINT "registration_sequences_course_check"
    CHECK ("course_opens_at" IS NULL OR "course_url" IS NOT NULL);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "registration_sequences" DROP CONSTRAINT IF EXISTS "registration_sequences_course_url_length_check";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "registration_sequences" ADD CONSTRAINT "registration_sequences_course_url_length_check"
    CHECK ("course_url" IS NULL OR length("course_url") BETWEEN 1 AND 2048);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "registration_sequences" ADD CONSTRAINT "registration_sequences_target_check"
    CHECK ("window_id" IS NOT NULL OR "course_url" IS NOT NULL);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "registration_sequences" ADD CONSTRAINT "registration_sequences_date_review_check"
    CHECK ("date_review_action_id" IS NULL OR "pending_change" IS NOT NULL);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registration_sequences_live_url_uniq"
  ON "registration_sequences" ("family_id", "course_url")
  WHERE "window_id" IS NULL AND ("outcome" IS NULL OR "outcome" = 'waitlisted');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registration_sequences_check_idx"
  ON "registration_sequences" ("next_check_at")
  WHERE "next_check_at" IS NOT NULL AND ("outcome" IS NULL OR "outcome" = 'waitlisted');
