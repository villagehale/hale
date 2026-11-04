-- VIL-156: an ended Google connection keeps no account key. endKeys now drops the key
-- whenever a row keeps no pending revoke, but rows ended before that still hold it twice:
-- in the column (0203 copied it from provider_metadata for every row, ended ones
-- included) and in provider_metadata (an ended row is never synced again, so nothing
-- overwrote it). Kept, the key links an ended row to a Google account across households
-- and blocks a co-parent from linking that account themselves.
--
-- 1. The provider_metadata copy goes from every row: the column is the key's only home
--    since 0203 (which filled the column from this copy wherever it was empty), and
--    nothing reads the copy.
-- 2. The column goes from every row that keeps no token: no live grant, no pending
--    revoke whose cancel or erasure decision still reads the key.
--
-- Additive (rule #9): data only, no schema change.
-- Re-runnable: each UPDATE matches only rows still carrying a key it clears.
-- Not reversible: the cleared keys are blind indexes Hale no longer needs.
UPDATE "integrations"
SET "provider_metadata" = "provider_metadata" - 'googleAccountKey'
WHERE "provider_metadata" -> 'googleAccountKey' IS NOT NULL;
--> statement-breakpoint
UPDATE "integrations"
SET "google_account_key" = NULL
WHERE "google_account_key" IS NOT NULL
  AND "oauth_tokens_encrypted" IS NULL
  AND "google_revoke_pending_encrypted" IS NULL;
