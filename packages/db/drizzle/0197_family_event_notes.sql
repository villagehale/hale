-- VIL-468. Logistics facts for one occasion: parking and what to bring, pulled
-- from the source event when it states them. Never the raw description.
-- Null on every row that stated neither, and on every row written before this.
-- Shape: {"parking"?: string, "bring"?: string}
-- Reversible:
--   ALTER TABLE "family_events" DROP COLUMN "notes";
ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "notes" jsonb;
