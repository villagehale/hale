-- Linq attachments on the inbound row, so a re-drive still has the photo URL.
-- Bytes are not stored. Null on every row that carried no attachment.
-- Reversible:
--   ALTER TABLE "channel_messages" DROP COLUMN "inbound_media";
ALTER TABLE "channel_messages" ADD COLUMN "inbound_media" jsonb;
