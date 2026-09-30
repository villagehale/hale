-- VIL-375 — a durable grant to share named signup slots with one provider host.
-- Additive (rule #9). Reversible: DROP TABLE IF EXISTS authorized_signup_consents;
-- Re-runnable: CREATE TABLE / INDEX use IF NOT EXISTS. RLS with no policy
-- denies the anon Data API; the app connects as postgres (BYPASSRLS).
-- The row is the parent's explicit yes: message id, family, activity, host,
-- the slot names they allowed, and the time. Values (names, email, date of
-- birth, postal code) are not columns. The message body is not copied.
CREATE TABLE IF NOT EXISTS "authorized_signup_consents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "message_id" text NOT NULL,
  "activity_key" text NOT NULL,
  "provider_host" text NOT NULL,
  "fields_allowed" text[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "authorized_signup_consents_message_chk" CHECK (
    char_length("message_id") BETWEEN 1 AND 200
    AND "message_id" = btrim("message_id")
  ),
  CONSTRAINT "authorized_signup_consents_activity_chk" CHECK (
    char_length("activity_key") BETWEEN 1 AND 80
  ),
  CONSTRAINT "authorized_signup_consents_host_chk" CHECK (
    char_length("provider_host") BETWEEN 1 AND 253
    AND "provider_host" = lower("provider_host")
    AND "provider_host" = btrim("provider_host")
    AND position(' ' IN "provider_host") = 0
  ),
  -- Keep this list in step with SHAREABLE_SIGNUP_FIELDS in apps/web/lib/signup/consent.ts.
  CONSTRAINT "authorized_signup_consents_fields_chk" CHECK (
    "fields_allowed" <@ ARRAY[
      'child_first_name',
      'child_last_name',
      'child_dob',
      'parent_first_name',
      'parent_email',
      'postal_code',
      'session',
      'visit_date',
      'party_size',
      'seating_note'
    ]::text[]
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "authorized_signup_consents_grant_uniq"
  ON "authorized_signup_consents" ("family_id", "message_id", "activity_key", "provider_host");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authorized_signup_consents_family_idx"
  ON "authorized_signup_consents" ("family_id", "created_at");--> statement-breakpoint
ALTER TABLE "authorized_signup_consents" ENABLE ROW LEVEL SECURITY;
