-- VIL-226 · the per-family proactive queue and the sending line's health.
-- Additive (rule #9). Re-runnable: every statement is guarded.
CREATE TABLE IF NOT EXISTS "proactive_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL,
  "parent_user_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "category" "channel_message_category" NOT NULL,
  "template_key" text NOT NULL,
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
  CONSTRAINT "proactive_candidates_parent_user_id_users_id_fk" FOREIGN KEY ("parent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "proactive_candidates_status_chk" CHECK ("status" IN ('queued', 'held', 'dropped', 'sent', 'shadowed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proactive_candidates_dedupe_idx" ON "proactive_candidates" USING btree ("family_id", "dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proactive_candidates_open_idx" ON "proactive_candidates" USING btree ("family_id", "created_at") WHERE "status" IN ('queued', 'held');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linq_line_health" (
  "phone_number" text PRIMARY KEY NOT NULL,
  "status" text NOT NULL,
  "paused" boolean NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proactive_candidates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "linq_line_health" ENABLE ROW LEVEL SECURITY;
