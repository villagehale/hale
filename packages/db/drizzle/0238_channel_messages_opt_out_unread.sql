-- INBOUND only: the door's opt-out read could not read this text (null after its retry),
-- so it may be a stop. Written in the same INSERT that records the text, which every
-- hand-off needs, so the fact cannot be lost the way a separate hold row can. The router
-- moves none of the parent's sign-up asks on a turn that carries it, and a turn that
-- reads several texts as one carries it if any of them does. Null on outbound rows and on
-- rows written before this column existed.
-- Add-only and nullable (rule #9). Re-runnable. Reversible:
--   ALTER TABLE "channel_messages" DROP COLUMN IF EXISTS "opt_out_unread";
ALTER TABLE "channel_messages" ADD COLUMN IF NOT EXISTS "opt_out_unread" boolean;
