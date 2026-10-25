-- Browser Use watch: rerunnable provider-page checks for schedules, openings and waitlists.
--
-- Family-agnostic ops data: a provider host, the page watched, the Browser Use workspace
-- that holds the provider's saved script, and what each run read. No family_id, no PII.
--
-- Additive. Re-runnable: IF NOT EXISTS throughout.
--
-- Reversible:
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
