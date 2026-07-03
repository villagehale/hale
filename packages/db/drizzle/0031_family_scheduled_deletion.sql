-- Reversible-by-grace family/account deletion (PIPEDA/Law 25 right-to-erasure),
-- additive only (rule #9). A confirm-gated request STAMPS this column with the
-- moment the grace period lapses; the worker hard-deletes the family only once
-- now() passes it. NULL = not scheduled — clearing it (before the worker fires)
-- cancels the deletion, which is what "reversible by grace" means. No destructive
-- edit: one nullable column, defaulting to NULL for every existing family.
ALTER TABLE "families" ADD COLUMN "scheduled_deletion_at" timestamp with time zone;
