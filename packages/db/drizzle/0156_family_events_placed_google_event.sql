-- The Google Calendar event Hale created for a placement (VIL-93).
--
-- Distinct from google_event_id, which mirrors an event the parent already
-- had. Move, cancel, and undo target placed_google_event_id only, so Hale
-- never edits a Google event it did not create. The mirror reconciler does
-- not read these columns.
--
-- Additive (rule #9). Both columns are nullable. Re-runnable.
-- ON DELETE SET NULL: disconnecting Google must not delete the Hale row.
--
-- Reversible:
--   ALTER TABLE family_events DROP CONSTRAINT IF EXISTS family_events_placed_google_integration_id_integrations_id_fk;
--   ALTER TABLE family_events
--     DROP COLUMN IF EXISTS placed_google_integration_id,
--     DROP COLUMN IF EXISTS placed_google_event_id;

ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "placed_google_event_id" text;--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "placed_google_integration_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_events"
    ADD CONSTRAINT "family_events_placed_google_integration_id_integrations_id_fk"
    FOREIGN KEY ("placed_google_integration_id") REFERENCES "integrations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
