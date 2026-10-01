-- VIL-394 — a household's explicit yes to a meet or a join-group.
-- Additive (rule #9). Reversible: DROP TABLE IF EXISTS same_activity_opt_ins;
-- Re-runnable: CREATE TABLE / INDEX use IF NOT EXISTS. RLS with no policy
-- denies the anon Data API; the app connects as postgres (BYPASSRLS).
--
-- What is absent is the privacy boundary. No child, no place, no other
-- household, no message body. activity_key is opaque and compared, never
-- parsed into who signed up or where a kid goes. A booking without an opt-in
-- is not a row in this table.
CREATE TABLE IF NOT EXISTS "same_activity_opt_ins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "activity_key" text NOT NULL,
  "kind" text NOT NULL,
  "message_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "same_activity_opt_ins_activity_chk" CHECK (
    char_length("activity_key") BETWEEN 1 AND 200
    AND "activity_key" = btrim("activity_key")
    AND position(E'\n' IN "activity_key") = 0
    AND position('@' IN "activity_key") = 0
  ),
  CONSTRAINT "same_activity_opt_ins_kind_chk" CHECK (
    "kind" IN ('meet', 'join_group')
  ),
  CONSTRAINT "same_activity_opt_ins_message_chk" CHECK (
    char_length("message_id") BETWEEN 1 AND 200
    AND "message_id" = btrim("message_id")
    AND position(E'\n' IN "message_id") = 0
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "same_activity_opt_ins_live_uniq"
  ON "same_activity_opt_ins" ("family_id", "activity_key", "kind")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "same_activity_opt_ins_activity_idx"
  ON "same_activity_opt_ins" ("activity_key", "kind")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "same_activity_opt_ins_family_idx"
  ON "same_activity_opt_ins" ("family_id", "created_at");--> statement-breakpoint
ALTER TABLE "same_activity_opt_ins" ENABLE ROW LEVEL SECURITY;
