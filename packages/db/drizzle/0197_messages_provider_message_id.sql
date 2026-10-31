-- VIL-479 · The Linq id of an assistant bubble Hale can edit in place.
-- Null on parent turns and on bubbles sent before this column existed.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "provider_message_id" text;
CREATE UNIQUE INDEX IF NOT EXISTS "messages_provider_message_id_uniq"
  ON "messages" ("provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;
