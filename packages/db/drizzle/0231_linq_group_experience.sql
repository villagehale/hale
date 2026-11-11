-- VIL-399 — live group-chat experience state (RSVP/time polls, a posted link,
-- a mail notice, a private question Hale moved 1:1).
-- Additive (rule #9). Reversible: DROP TABLE IF EXISTS linq_group_experience;
-- Re-runnable: CREATE TABLE / INDEX use IF NOT EXISTS. RLS with no policy
-- denies the anon Data API; the app connects as postgres (BYPASSRLS).
--
-- One live row per (chat, kind, subject). A later close sets closed_at rather
-- than deleting, so the moment stays a fact. The family cascade is erasure.
CREATE TABLE IF NOT EXISTS "linq_group_experience" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chat_id" text NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "subject_key" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_experience_live_uniq"
  ON "linq_group_experience" ("chat_id", "kind", "subject_key")
  WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_experience_chat_idx"
  ON "linq_group_experience" ("chat_id", "kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_experience_family_idx"
  ON "linq_group_experience" ("family_id", "created_at");--> statement-breakpoint
ALTER TABLE "linq_group_experience" ENABLE ROW LEVEL SECURITY;
