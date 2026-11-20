-- VIL-302 · Every ask a parent may answer with a bare yes ranks on ONE clock taken at ONE
-- point of its send. `channel_messages.sent_at` is each caller's own start time (before
-- the send), `created_at` is before the send on a row claimed first, and the sign-up lane
-- stamped its own column after the send, so two asks texted seconds apart could rank in
-- the wrong order. `send_recorded_at` is the database clock when a row first records its
-- send (`sent_at` goes from unset to set), stamped here by a trigger so no writer can
-- supply a different time. `authorized_signup_offers.last_asked_message_id` names the row
-- that carried the sign-up text whose number is `last_asked_seq`, so that text is dated by
-- the same column.
--
-- Additive. Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION, and the
-- trigger is dropped if present before it is created. Rows written before this migration
-- keep null: their send time is not known, and a parent's bare yes between asks of unknown
-- order makes Hale ask which.
--
-- Reversible:
--   DROP TRIGGER IF EXISTS "channel_messages_send_recorded_at" ON "channel_messages";
--   DROP FUNCTION IF EXISTS "channel_messages_send_recorded_at"();
--   ALTER TABLE "authorized_signup_offers" DROP COLUMN IF EXISTS "last_asked_message_id";
--   ALTER TABLE "channel_messages" DROP COLUMN IF EXISTS "send_recorded_at";
ALTER TABLE "channel_messages" ADD COLUMN IF NOT EXISTS "send_recorded_at" timestamp with time zone;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "channel_messages_send_recorded_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."direction" = 'out' AND NEW."sent_at" IS NOT NULL AND NEW."send_recorded_at" IS NULL THEN
    NEW."send_recorded_at" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "channel_messages_send_recorded_at" ON "channel_messages";--> statement-breakpoint
CREATE TRIGGER "channel_messages_send_recorded_at" BEFORE INSERT OR UPDATE OF "sent_at" ON "channel_messages" FOR EACH ROW EXECUTE FUNCTION "channel_messages_send_recorded_at"();--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "last_asked_message_id" uuid REFERENCES "channel_messages"("id") ON DELETE SET NULL;
