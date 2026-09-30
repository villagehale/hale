-- VIL-375 step 2 — one pending parent-authorized signup offer per family.
-- Additive (rule #9). Reversible: DROP TABLE IF EXISTS authorized_signup_offers;
-- Re-runnable: CREATE TABLE / INDEX use IF NOT EXISTS. RLS with no policy
-- denies the anon Data API; the app connects as postgres (BYPASSRLS).
-- The row holds the public registration target and the session the parent
-- authorized. Child names, emails, and phone numbers are not columns.
CREATE TABLE IF NOT EXISTS "authorized_signup_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "child_id" uuid NOT NULL REFERENCES "children"("id") ON DELETE cascade,
  "parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "activity_key" text NOT NULL,
  "registration_url" text NOT NULL,
  "sessions" jsonb NOT NULL,
  "approved_price_cents" integer,
  "status" text DEFAULT 'pending' NOT NULL,
  "authorized_session_id" text,
  "authorizing_message_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "authorized_signup_offers_status_chk" CHECK (
    "status" IN ('pending', 'submitting', 'completed', 'handed_back')
  ),
  CONSTRAINT "authorized_signup_offers_url_len" CHECK (char_length("registration_url") <= 2000),
  CONSTRAINT "authorized_signup_offers_price_chk" CHECK (
    "approved_price_cents" IS NULL OR "approved_price_cents" >= 0
  )
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authorized_signup_offers_family_idx"
  ON "authorized_signup_offers" ("family_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "authorized_signup_offers_one_pending"
  ON "authorized_signup_offers" ("family_id")
  WHERE "status" = 'pending';--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ENABLE ROW LEVEL SECURITY;
