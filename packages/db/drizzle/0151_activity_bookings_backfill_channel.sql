-- Booked-detection backfill records a class the family already holds without
-- texting them about mail that arrived before Gmail was connected. Those rows
-- have no outbound channel_messages id. A live alert still writes one.
--
-- Additive (rule #9): DROP NOT NULL only. Existing rows keep their ids. Safe to
-- re-run: dropping NOT NULL on an already-nullable column is a no-op.
ALTER TABLE "activity_bookings" ALTER COLUMN "channel_message_id" DROP NOT NULL;
