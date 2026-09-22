-- The unconfirmed Google given name, held until the parent says yes.
-- Parent-facing copy reads users.name only. This column is the candidate behind
-- "Can I call you {first}?" and is cleared on yes (copied into name) or no.
-- Additive, nullable, no default: a row that predates the column has no candidate,
-- which is the truth (rule #9). Never a phone number.
ALTER TABLE "public"."users"
  ADD COLUMN IF NOT EXISTS "google_given_name" text;
