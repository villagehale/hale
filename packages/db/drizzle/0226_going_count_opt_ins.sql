-- VIL-399 — a household's explicit yes to being counted in "who else is going".
-- Additive (rule #9). Reversible: DROP TABLE IF EXISTS going_count_opt_ins;
-- Re-runnable: CREATE TABLE / INDEX use IF NOT EXISTS. RLS with no policy
-- denies the anon Data API; the app connects as postgres (BYPASSRLS).
--
-- A booking without an opt-in is not a row here, so the going-count query
-- cannot learn that household goes. One live row per family. A later no
-- sets revoked_at rather than deleting the yes.
CREATE TABLE IF NOT EXISTS "going_count_opt_ins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "going_count_opt_ins_live_uniq"
  ON "going_count_opt_ins" ("family_id")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "going_count_opt_ins_family_idx"
  ON "going_count_opt_ins" ("family_id", "created_at");--> statement-breakpoint
ALTER TABLE "going_count_opt_ins" ENABLE ROW LEVEL SECURITY;
