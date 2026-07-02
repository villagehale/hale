-- Per-device Expo push tokens (additive only, rule #9). One row per device: a
-- UNIQUE expo_push_token bound to a user (user_id → users.id, cascade on user
-- delete), the platform (ios/android), and a last_seen_at bumped on every
-- re-registration so stale device tokens are distinguishable. A device that
-- re-registers upserts on the unique token, re-pointing it to the current user
-- rather than duplicating rows. The token is a device address, never a child's
-- content (rule #1) — it is never logged.
CREATE TABLE IF NOT EXISTS "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expo_push_token" text NOT NULL,
	"platform" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_tokens_expo_push_token_unique" ON "push_tokens" USING btree ("expo_push_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_tokens_user_idx" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0023. The app
-- connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1 — device
-- push tokens must never be reachable through the public Data API.
ALTER TABLE "push_tokens" ENABLE ROW LEVEL SECURITY;
