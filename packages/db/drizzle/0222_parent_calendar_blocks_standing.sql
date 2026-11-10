-- VIL-651 · where the connecting parent stands on a household calendar block ('organizer',
-- 'accepted', 'own' or 'invited', the same rule as family_events.calendar_standing), and the
-- child the block is about. A title is stored only on an organizer or own kid block; anyone
-- else's keeps its child, day and times, with no title, so the group can still hear about it
-- in Hale's words. Null on every row written before these columns existed: a null standing
-- reads as not the parent's own, so its title is never spoken, and the row is not rewritten.
-- Additive (rule #9). Nullable columns, no default. Re-runnable: IF NOT EXISTS. Reversible:
--   ALTER TABLE parent_calendar_blocks DROP COLUMN IF EXISTS calendar_standing;
--   ALTER TABLE parent_calendar_blocks DROP COLUMN IF EXISTS child_id;

ALTER TABLE "parent_calendar_blocks" ADD COLUMN IF NOT EXISTS "calendar_standing" text;
--> statement-breakpoint
ALTER TABLE "parent_calendar_blocks" ADD COLUMN IF NOT EXISTS "child_id" uuid REFERENCES "children"("id") ON DELETE SET NULL;
