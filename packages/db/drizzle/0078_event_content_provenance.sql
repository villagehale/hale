-- VIL-260 (WS3b · teen gate) — one additive column, nothing else.
--
-- Rule #1's double-miss fallback redacts any draft the classifier could not attribute
-- to a child whenever the family has a teenager. That is correct for content that came
-- from OUTSIDE Hale, where "unattributed" really can mean "the teen's". It is wrong for
-- a draft Hale AUTHORED from public reference data (a municipal registration window):
-- there is no child-authored content in it to protect, and with no attributed child no
-- grant could ever unlock it — so a toddler family with a teen sibling could not
-- approve the registration shortlist at all.
--
-- Additive only (rule #9): NOT NULL with a DEFAULT of the PRIVATE value, so every
-- existing row — all of which carry ingested/classified content — keeps exactly
-- today's behaviour, and any mint site that does not declare its provenance fails
-- closed. Stored as text with a Drizzle $type<> union (the classifier_suggestion
-- precedent) rather than a new enum type: @hale/db is a leaf package and the closed
-- set is enforced in TypeScript.
ALTER TABLE "public"."events"
  ADD COLUMN IF NOT EXISTS "content_provenance" text NOT NULL DEFAULT 'child_content';
