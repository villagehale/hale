-- Single-use nonces for the MOBILE connector OAuth flow (additive only, rule #9).
-- The web connect flow closes consent-fixation with a session check at the callback;
-- the mobile callback has no browser session, so a mobile connect mints a nonce row
-- here, embeds its id in the signed state, and the callback CONSUMES it (deletes the
-- row) — a captured/replayed mobile consent url can complete a connection at most
-- once (rule #1). The nonce IS the row id; `expires_at` bounds the window.
CREATE TABLE IF NOT EXISTS "connector_connect_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE CASCADE,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_connect_nonces_family_idx" ON "connector_connect_nonces" USING btree ("family_id");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0023/0028. The
-- app connects as postgres (BYPASSRLS); Hale never uses the Data API.
ALTER TABLE "connector_connect_nonces" ENABLE ROW LEVEL SECURITY;
