-- VIL-226 · proactive candidates, line health, and one quiet window.
-- Additive (rule #9). Re-runnable.

ALTER TYPE "public"."agent_name" ADD VALUE IF NOT EXISTS 'proactive-decider';
--> statement-breakpoint
ALTER TYPE "public"."agent_name" ADD VALUE IF NOT EXISTS 'proactive-writer';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proactive_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "what" text NOT NULL,
  "why" text NOT NULL,
  "source_url" text,
  "worthless_after" timestamp with time zone,
  "parent_requested" boolean DEFAULT false NOT NULL,
  "dedupe_key" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "decision" text,
  "reason" text,
  "hold_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  CONSTRAINT "proactive_candidates_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "proactive_candidates_status_chk" CHECK ("status" IN ('queued', 'held', 'dropped', 'sent', 'shadowed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proactive_candidates_open_idx" ON "proactive_candidates" USING btree ("family_id", "created_at") WHERE "status" IN ('queued', 'held');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proactive_candidates_open_dedupe_idx" ON "proactive_candidates" ("family_id", "dedupe_key") WHERE "status" IN ('queued', 'held');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_line_health" (
  "phone_number" text PRIMARY KEY NOT NULL,
  "status" text NOT NULL,
  "paused" boolean NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loop_prefs" ALTER COLUMN "quiet_hours_start" SET DEFAULT '21:00:00';
--> statement-breakpoint
ALTER TABLE "loop_prefs" ALTER COLUMN "quiet_hours_end" SET DEFAULT '08:00:00';
--> statement-breakpoint
UPDATE "loop_prefs"
SET "quiet_hours_start" = '21:00:00', "quiet_hours_end" = '08:00:00'
WHERE "quiet_hours_start" = '21:30:00' AND "quiet_hours_end" = '07:30:00';
