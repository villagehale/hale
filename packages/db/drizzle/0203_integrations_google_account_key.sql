-- VIL-156: the Google account a connector row was granted by, as a keyed blind index
-- (never the account id itself), in its own column. It used to ride in
-- provider_metadata, which every calendar and Drive sync replaces with its cursor, so
-- the key was gone after the first sync. Two decisions read it: whether a family
-- erasure may revoke a grant another household still uses on the same account, and
-- which waiting revoke a fresh connect of that account cancels. The connect callback
-- writes it; no sync writes it.
--
-- Additive (rule #9): one nullable column, no index (read by one equality on a small table).
-- Backfill: a row whose metadata still carries the key gets it; a row a sync already
-- overwrote stays NULL, and both decisions fall back to the Hale user for it.
-- Re-runnable: IF NOT EXISTS, and the backfill fills only a NULL column.
-- Reversible:
--   ALTER TABLE integrations DROP COLUMN IF EXISTS google_account_key;
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "google_account_key" text;
--> statement-breakpoint
UPDATE "integrations"
SET "google_account_key" = "provider_metadata"->>'googleAccountKey'
WHERE "google_account_key" IS NULL
  AND "provider_metadata"->>'googleAccountKey' IS NOT NULL;
