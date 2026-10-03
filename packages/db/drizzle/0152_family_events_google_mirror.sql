-- A Google Calendar event Hale is willing to remind about, stored as a
-- parent-sourced family_events row so the existing reminder cron (evening
-- before at 18:00, and one hour before) can see it without a YES.
--
-- Additive (rule #9). Both columns are nullable, so every existing row stays
-- valid. Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT
-- EXISTS, and the foreign key is inside a duplicate-object guard.
--
-- Reversible:
--   DROP INDEX IF EXISTS family_events_google_event_uniq;
--   ALTER TABLE family_events DROP CONSTRAINT IF EXISTS family_events_integration_id_integrations_id_fk;
--   ALTER TABLE family_events
--     DROP COLUMN IF EXISTS integration_id,
--     DROP COLUMN IF EXISTS google_event_id;

ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "google_event_id" text;--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "integration_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "family_events"
    ADD CONSTRAINT "family_events_integration_id_integrations_id_fk"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "family_events_google_event_uniq"
  ON "family_events" ("integration_id", "google_event_id")
  WHERE "google_event_id" IS NOT NULL;
