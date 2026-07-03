-- Soft delete for quick-log episodes (additive only, rule #9). A parent may edit
-- or remove a feed/nap/milestone they logged; a hard DELETE would erase the row
-- the audit trail references (rule #6, PIPEDA right-to-access). Instead we stamp
-- `deleted_at`: the read path filters it out, the row (and its audit history)
-- stays intact. NULL = live, a timestamp = removed by the parent.
ALTER TABLE "family_memory_episodes" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
-- The hot read path already filters by (family_id, occurred_at); deleted_at is an
-- extra predicate on every list read, so index the pair the read scans.
CREATE INDEX IF NOT EXISTS "memory_episodes_family_deleted_idx" ON "family_memory_episodes" USING btree ("family_id","deleted_at");
