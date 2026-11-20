-- VIL-635 · a one-adult audit row stays with its adult.
--
-- audit_log only had family_id, so History and the access export showed every row
-- to every adult. A nullable audience names the parent who may see the row. Rows
-- written before this column stay null (rule #6: audit rows are never rewritten);
-- History and the export still treat the listed one-adult verbs as internal at
-- read time for those legacy rows.
--
-- Additive (rule #9). Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- Reversible:
--   DROP INDEX IF EXISTS "audit_log_family_audience_idx";
--   ALTER TABLE "audit_log" DROP COLUMN IF EXISTS "audience";

ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "audience" uuid REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_family_audience_idx" ON "audit_log" ("family_id", "audience");
