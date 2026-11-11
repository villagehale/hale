-- VIL-649 · which intake session became this family. Erasure follows this tie
-- rather than inferring from the number alone. A family-less session of a
-- previous holder of a recycled number stays. Additive (rule #9).
-- ON DELETE SET NULL: the row is the funnel's arrival record; redaction keeps
-- it after the family is gone (family_id still cascades the provisioned row).
-- Re-runnable: IF NOT EXISTS.
-- Reversible:
--   ALTER TABLE sms_intake_sessions DROP COLUMN IF EXISTS became_family_id;

ALTER TABLE "sms_intake_sessions" ADD COLUMN IF NOT EXISTS "became_family_id" uuid REFERENCES "families"("id") ON DELETE SET NULL;
