-- What a proactive thread row was ABOUT, so the coach can answer a reply to it. The email
-- alert writes { kind: 'gmail', eventId, gmailMessageId, snippet }. Snippet is null for a
-- 13+ child's mail. Add-only and nullable: every existing row, and every other writer,
-- leaves it null. Never copied to a log or an audit row; it lives on the coach's own
-- transcript row and goes when the row does.
-- Reversible:
--   ALTER TABLE "messages" DROP COLUMN "source";
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "source" jsonb;
