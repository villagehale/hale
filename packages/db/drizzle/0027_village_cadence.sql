-- Village cadence: how a discovered activity recurs, for the feed's cadence chip.
-- Additive only (rule #9): one nullable column on village_candidates. Holds the
-- model's cadence label ("seasonal" | "one-time" | "ongoing"); pre-cadence rows
-- and unclassified candidates stay NULL (no chip). Free text, not an enum, so a
-- new label lands without another migration. RLS already enabled (0012/0016).
ALTER TABLE "village_candidates" ADD COLUMN "cadence" text;
