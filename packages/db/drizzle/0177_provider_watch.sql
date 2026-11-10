-- Browser Use watch: rerunnable provider-page checks for schedules, openings and waitlists.
--
-- Targets, workspaces and readings are family-agnostic: a provider host, the page watched,
-- the Browser Use workspace that holds the provider's saved script, and what each run read.
-- family_watch_subscriptions is the one family-scoped table: which family asked for which
-- target, the conversation and a hash of the parent's words that carried their agreement,
-- and when they turned it off. The sweep runs only targets with a live subscription.
--
-- Additive. Re-runnable: IF NOT EXISTS throughout.
--
-- Reversible:
--   DROP TABLE IF EXISTS family_watch_subscriptions;
--   DROP TABLE IF EXISTS provider_watch_readings;
--   DROP TABLE IF EXISTS provider_watch_targets;
--   DROP TABLE IF EXISTS provider_watch_workspaces;
CREATE TABLE IF NOT EXISTS "provider_watch_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_host" text NOT NULL,
	"browser_use_workspace_id" text NOT NULL,
	"script_saved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_watch_workspaces_host_length_check" CHECK (char_length("provider_host") <= 253)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_watch_workspaces_host_idx" ON "provider_watch_workspaces" ("provider_host");--> statement-breakpoint
ALTER TABLE "provider_watch_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_watch_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_host" text NOT NULL,
	"source_url" text NOT NULL,
	"kind" text NOT NULL,
	"interval_minutes" integer DEFAULT 360 NOT NULL,
	"use_proxy" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_watch_targets_kind_check" CHECK ("kind" IN ('schedule', 'openings', 'waitlist')),
	CONSTRAINT "provider_watch_targets_interval_check" CHECK ("interval_minutes" >= 60)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_watch_targets_url_kind_idx" ON "provider_watch_targets" ("source_url","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_watch_targets_due_idx" ON "provider_watch_targets" ("enabled","next_run_at");--> statement-breakpoint
ALTER TABLE "provider_watch_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_watch_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL REFERENCES "provider_watch_targets"("id") ON DELETE cascade,
	"provider_host" text NOT NULL,
	"outcome" text NOT NULL,
	"run_id" text,
	"session_id" text,
	"reading" jsonb,
	"cost_usd" numeric(10, 4) DEFAULT 0 NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "provider_watch_readings_outcome_check" CHECK ("outcome" IN ('read', 'unreadable', 'failed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_watch_readings_host_read_idx" ON "provider_watch_readings" ("provider_host","read_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_watch_readings_read_idx" ON "provider_watch_readings" ("read_at");--> statement-breakpoint
ALTER TABLE "provider_watch_readings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "family_watch_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"target_id" uuid NOT NULL REFERENCES "provider_watch_targets"("id") ON DELETE cascade,
	"source_ref" text NOT NULL,
	"consent_conversation_id" text NOT NULL,
	"consent_message_sha256" text NOT NULL,
	"consent_quote" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "family_watch_subscriptions_quote_length_check" CHECK (char_length("consent_quote") <= 300)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "family_watch_subscriptions_live_idx" ON "family_watch_subscriptions" ("family_id","target_id") WHERE "removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "family_watch_subscriptions_target_idx" ON "family_watch_subscriptions" ("target_id");--> statement-breakpoint
ALTER TABLE "family_watch_subscriptions" ENABLE ROW LEVEL SECURITY;
