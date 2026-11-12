-- The service Linq said carried an inbound text: iMessage, SMS or RCS. Linq relays
-- every chat on the Hale line as `channel = 'imessage'`, green-bubble chats included,
-- so the channel alone cannot say whether a reply may go as several bubbles (only a
-- real iMessage chat keeps them in order). Null on every other pipe, on outbound rows,
-- on a payload that did not say, and on rows written before this column existed.
-- Add-only and nullable (rule #9). Re-runnable. Reversible:
--   ALTER TABLE "channel_messages" DROP COLUMN IF EXISTS "provider_service";
ALTER TABLE "channel_messages" ADD COLUMN IF NOT EXISTS "provider_service" text;
