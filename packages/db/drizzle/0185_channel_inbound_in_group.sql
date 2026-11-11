-- VIL-463: the door's group bit on the inbound row, so a reconciler re-drive knows
-- whether the text came from a group chat. Null on rows written before this column
-- (and on every outbound row); the router refuses an iMessage re-drive whose bit is
-- still null rather than run it as a 1:1 turn.
-- Reversible:
--   ALTER TABLE "channel_messages" DROP COLUMN "in_group";
ALTER TABLE "channel_messages" ADD COLUMN IF NOT EXISTS "in_group" boolean;
