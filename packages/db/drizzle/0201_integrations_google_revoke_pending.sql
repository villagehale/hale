-- VIL-156: a disconnect revokes Hale's grant at Google. The local half commits first and
-- nulls oauth_tokens_encrypted at once; ONE token (the refresh token when the row held
-- one, else the access token) moves here, envelope-encrypted under APP_ENCRYPTION_KEY,
-- only until Google confirms the revoke. Only the revoke reads this column: sync, push
-- and Settings read oauth_tokens_encrypted alone, so a pending row grants no access.
-- google_revoke_pending_since bounds how long it is kept (seven days, then deleted).
--
-- Additive (rule #9): two nullable columns, no index (rare rows on a small table).
-- Rows written before this file keep NULL: nothing pending.
-- Re-runnable: IF NOT EXISTS throughout.
-- Reversible:
--   ALTER TABLE integrations DROP COLUMN IF EXISTS google_revoke_pending_since;
--   ALTER TABLE integrations DROP COLUMN IF EXISTS google_revoke_pending_encrypted;
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "google_revoke_pending_encrypted" text;
--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "google_revoke_pending_since" timestamp with time zone;
