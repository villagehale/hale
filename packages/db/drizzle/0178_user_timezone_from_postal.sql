-- Signup writes users.timezone from the postal code (Canada or US).
-- New rows no longer land on America/Toronto when an insert omits a zone.
-- Existing rows are unchanged. UTC is only the placeholder until a place is known.
-- Reversible:
--   ALTER TABLE "users" ALTER COLUMN "timezone" SET DEFAULT 'America/Toronto';
ALTER TABLE "users" ALTER COLUMN "timezone" SET DEFAULT 'UTC';
