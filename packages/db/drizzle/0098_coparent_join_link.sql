-- The forwardable co-parent join link. Additive only (rule #9): one new table and one
-- new enum value. Nothing existing is altered, and on an unmigrated database every
-- statement here is a no-op.
--
-- WHY A TABLE AND NOT A DERIVED CODE. The referral tag (`friend-…`) is HMAC(family id)
-- with no row behind it, because it must be stable and it grants nothing. This token is
-- the opposite on both counts: whoever holds it becomes a CO-PARENT of the family, so it
-- has to be genuinely random, single-use, and bounded by an expiry — none of which a
-- derived code can be.
--
-- WHY ONLY THE DIGEST (rule #1). `token_hash` is SHA-256 of the lowercased code, on the
-- magic_link_tokens precedent: a link that confers access is a secret, and a database
-- read must never be able to reconstruct one. Redemption hashes what arrived and looks
-- the digest up; there is no column here that could be read back out onto a phone.
--
-- NO PHONE COLUMNS AT ALL, unlike caregiver_invites. Hale texts nobody on this path —
-- the parent forwards the link in their own thread and the partner's own first message
-- is their CASL basis — so there is no third party's number to hold, and holding one
-- would be collecting a number nobody asked us to have.
CREATE TABLE IF NOT EXISTS "join_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	-- The parent who asked. Their request IS the authorization, recorded beside this row
	-- as a `co_parent_access_grant` consent record.
	"invited_by_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	-- Fixed to 'co_parent' in v1, stored rather than assumed so the grant the parent
	-- consented to and the membership that lands cannot diverge.
	"role" "family_role" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	-- The burn that makes the link single-use. NULL = still open.
	"consumed_at" timestamp with time zone,
	"consumed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- One row per issued token, and the lookup the redemption resolves on.
-- Guarded like 0103's check: this file was applied to prod by hand before the deploy
-- leg ever ran it, and a bare ADD CONSTRAINT is the one statement here that throws on
-- a second pass (2026-09-04 — four red Deploy runs, 0099 silently never applied).
DO $$ BEGIN
  ALTER TABLE "join_invites" ADD CONSTRAINT "join_invites_token_hash_unique" UNIQUE("token_hash");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "join_invites" ADD CONSTRAINT "join_invites_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "join_invites" ADD CONSTRAINT "join_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
-- SET NULL rather than cascade: a co-parent erased later must not take the record of
-- the invitation with them — what was granted, by whom, and when is the PIPEDA answer.
DO $$ BEGIN
  ALTER TABLE "join_invites" ADD CONSTRAINT "join_invites_consumed_by_user_id_users_id_fk" FOREIGN KEY ("consumed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "join_invites_family_idx" ON "join_invites" ("family_id");--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The
-- app connects as postgres (BYPASSRLS) and reads this server-side. Rule #1 — and it
-- matters more here than on most tables: a row that leaks is a row about who may join
-- a household.
ALTER TABLE "join_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- The parent's authorization to seat a co-parent, recorded at mint time. Its own type
-- rather than caregiver_access_grant: that one authorizes a SCOPED slice to a named
-- person on a named number, and this one authorizes the whole family surface for
-- whoever opens the link.
ALTER TYPE "public"."consent_type" ADD VALUE IF NOT EXISTS 'co_parent_access_grant';
