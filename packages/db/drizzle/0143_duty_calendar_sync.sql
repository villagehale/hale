-- VIL-383 — duty on Hale's own family_events, and duty rows in the
-- 1:1 → group sync queue.
--
-- Additive (rule #9). Existing rows stay valid: every new column is
-- nullable, and the decision check is widened (picked and passed still
-- pass). Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS, and the constraint rewrite drops IF EXISTS before adding.
-- Nothing is deleted. Google Calendar is not touched.
--
-- Reversible:
--   ALTER TABLE family_events DROP CONSTRAINT IF EXISTS family_events_duty_owner_kind_chk;
--   ALTER TABLE family_events DROP CONSTRAINT IF EXISTS family_events_duty_role_chk;
--   ALTER TABLE family_events DROP CONSTRAINT IF EXISTS family_events_duty_owner_user_id_users_id_fk;
--   DROP INDEX IF EXISTS family_events_duty_fact_idx;
--   ALTER TABLE family_events
--     DROP COLUMN IF EXISTS duty_set_at,
--     DROP COLUMN IF EXISTS duty_fact_key,
--     DROP COLUMN IF EXISTS duty_role,
--     DROP COLUMN IF EXISTS duty_owner_kind,
--     DROP COLUMN IF EXISTS duty_owner_label,
--     DROP COLUMN IF EXISTS duty_owner_user_id;
--   -- restore the 0133 checks if duty rows are gone:
--   -- decision IN ('picked', 'passed') and the original slots check.

ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "duty_owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "duty_owner_label" text;--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "duty_owner_kind" text;--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "duty_role" text;--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "duty_fact_key" text;--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "duty_set_at" timestamp with time zone;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_events"
    ADD CONSTRAINT "family_events_duty_owner_user_id_users_id_fk"
    FOREIGN KEY ("duty_owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_events"
    ADD CONSTRAINT "family_events_duty_owner_kind_chk"
    CHECK ("duty_owner_kind" IS NULL OR "duty_owner_kind" IN ('parent', 'named', 'both'));
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_events"
    ADD CONSTRAINT "family_events_duty_role_chk"
    CHECK ("duty_role" IS NULL OR "duty_role" IN ('dropoff', 'pickup', 'attend'));
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "family_events_duty_fact_idx"
  ON "family_events" ("family_id", "duty_fact_key")
  WHERE "duty_fact_key" IS NOT NULL;--> statement-breakpoint

-- Widen picked/passed so a duty decision can wait in the same queue.
-- Drop then add, so a second run does not collide with the new check.
DO $$ BEGIN
  ALTER TABLE "group_decision_sync" DROP CONSTRAINT IF EXISTS "group_decision_sync_decision_chk";
  ALTER TABLE "group_decision_sync" DROP CONSTRAINT IF EXISTS "group_decision_sync_slots_chk";
  ALTER TABLE "group_decision_sync"
    ADD CONSTRAINT "group_decision_sync_decision_chk"
    CHECK ("decision" IN ('picked', 'passed', 'duty'));
  ALTER TABLE "group_decision_sync"
    ADD CONSTRAINT "group_decision_sync_slots_chk"
    CHECK (
      ("decision" = 'picked' AND "day" IS NOT NULL AND "time" IS NOT NULL)
      OR ("decision" = 'passed' AND "day" IS NULL AND "time" IS NULL)
      OR ("decision" = 'duty' AND "day" IS NOT NULL AND "time" IS NOT NULL)
    );
END $$;
