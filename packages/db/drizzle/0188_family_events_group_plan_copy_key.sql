-- VIL-455. The claim key for a group plan's per-family copy: a UUID derived from
-- (group plan, family). Kept apart from placed_by_action_id, which readers join to
-- actions (mid-activity sweep, review subject). Null on every other row.
-- Additive only. Reversible:
--   DROP INDEX IF EXISTS "family_events_group_plan_copy_key_uniq";
--   ALTER TABLE "family_events" DROP COLUMN "group_plan_copy_key";
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "group_plan_copy_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "family_events_group_plan_copy_key_uniq" ON "family_events" USING btree ("group_plan_copy_key") WHERE "family_events"."group_plan_copy_key" IS NOT NULL;
