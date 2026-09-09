-- 0111 · registration_sequences.course_url gets the length bound the app already
-- enforces (apps/web/lib/channel/spots/url.ts MAX_URL_CHARS = 200): a bound course URL
-- is quoted into an SMS whose segment budget is computed against that number, so a
-- longer value would only ever come from a write that skipped sanitizeSpotUrl.
-- Additive: one CHECK, no data change (every existing row is NULL or sanitized).
--
-- Wrapped in a DO block (the 0080 / 0110 precedent) because Postgres 16 has no
-- ADD CONSTRAINT IF NOT EXISTS, and the Deploy migrate leg re-runs every file past the
-- ledger watermark (PRs #609/#610): a bare ADD CONSTRAINT raises on the second pass.
DO $$
BEGIN
  ALTER TABLE "registration_sequences"
    ADD CONSTRAINT "registration_sequences_course_url_length_check"
    CHECK ("course_url" IS NULL OR length("course_url") <= 200);
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;
