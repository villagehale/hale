-- One live login card per provider host per family, by construction. A live card is an
-- unspent row (`consumed_at IS NULL`); expiry is a clock, so it cannot sit in a partial
-- index predicate. Every mint spends the host's unspent rows, expired ones included, and
-- inserts the new card in one transaction, so an expired card never holds the slot.
-- `sent_at`: when the card reached the parent's thread. A retried notice reuses the card
-- it already sent instead of minting a second one; a card that never went is replaced.
-- Prod held no provider_login_links rows when this was written, so nothing to clean up.
-- Add-only (rule #9). Re-runnable. Reversible:
--   DROP INDEX IF EXISTS "provider_login_links_one_live_per_host";
--   ALTER TABLE "provider_login_links" DROP COLUMN IF EXISTS "sent_at";
ALTER TABLE "provider_login_links" ADD COLUMN IF NOT EXISTS "sent_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_login_links_one_live_per_host"
	ON "provider_login_links" ("family_id","provider_host")
	WHERE "consumed_at" IS NULL;
