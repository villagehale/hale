-- VIL-401 — Google Calendar events.watch and Gmail users.watch, one row per connection.
-- Additive (rule #9): a new table. An empty table changes nothing the poll does.
--
-- The sync cursor stays on integrations.provider_metadata (historyId / syncToken). That
-- blob is replaced on every successful sync, so channel id, resource id, expiration and
-- the debounce window live here, where a sync cannot wipe them.
--
-- The channel token and the mailbox address are not columns. token_hash is SHA-256 of
-- the secret Google echoes; mailbox_key is the email blind index a Pub/Sub push is
-- routed by. Neither value is the thing it stands in for (rule #1).
--
-- Reversible: DROP TABLE google_push_subscriptions;

CREATE TABLE IF NOT EXISTS "google_push_subscriptions" (
	"integration_id" uuid PRIMARY KEY REFERENCES "integrations"("id") ON DELETE cascade,
	"provider" text NOT NULL,
	"channel_id" text,
	"resource_id" text,
	"token_hash" text,
	"mailbox_key" text,
	"topic_name" text,
	"expiration" timestamp with time zone,
	"debounce_until" timestamp with time zone,
	"pending" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_push_subscriptions_provider_chk" CHECK ("provider" IN ('gcal', 'gmail')),
	CONSTRAINT "google_push_subscriptions_shape_chk" CHECK (
		(
			"provider" = 'gcal'
			AND "channel_id" IS NOT NULL
			AND "resource_id" IS NOT NULL
			AND "token_hash" IS NOT NULL
		) OR (
			"provider" = 'gmail'
			AND "mailbox_key" IS NOT NULL
			AND "topic_name" IS NOT NULL
		)
	)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "google_push_subscriptions_channel_id_idx"
	ON "google_push_subscriptions" ("channel_id")
	WHERE "channel_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "google_push_subscriptions_mailbox_idx"
	ON "google_push_subscriptions" ("mailbox_key");--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The app
-- connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "google_push_subscriptions" ENABLE ROW LEVEL SECURITY;
