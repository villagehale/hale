-- The phone-channel sign-in token: magic_link_tokens' exact lifecycle keyed on
-- user_id instead of email. Additive only (rule #9): one new table, nothing existing
-- altered.
--
-- WHY. An SMS-onboarded parent has email NULL and external_auth_id
-- 'sms:<phone blind index>', so an email magic link cannot reach them — and redeeming
-- one would find-or-create a SECOND, empty account beside the family the number
-- already owns. This table lets a routed inbound turn mint a link whose redemption
-- resolves the identity the account ALREADY has and can create nothing.
--
-- WHY ONLY THE DIGEST (rule #1). The token grants a signed-in session — account
-- takeover if leaked — so token_hash is SHA-256 of the raw token, on the
-- magic_link_tokens precedent: a database read can never reconstruct a usable link.
CREATE TABLE IF NOT EXISTS "channel_signin_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	-- The burn that makes the link single-use. NULL = still open.
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- One row per issued token, and the lookup the redemption resolves on.
-- Guarded like 0103's check: applied to prod by hand before the deploy leg ran it, and a
-- bare ADD CONSTRAINT throws on the second pass (see 0098).
DO $$ BEGIN
  ALTER TABLE "channel_signin_tokens" ADD CONSTRAINT "channel_signin_tokens_token_hash_unique" UNIQUE("token_hash");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "channel_signin_tokens" ADD CONSTRAINT "channel_signin_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- The invalidate-prior-on-mint UPDATE reads by user.
CREATE INDEX IF NOT EXISTS "channel_signin_tokens_user_idx" ON "channel_signin_tokens" ("user_id");--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The
-- app connects as postgres (BYPASSRLS) and reads this server-side. Rule #1.
ALTER TABLE "channel_signin_tokens" ENABLE ROW LEVEL SECURITY;
