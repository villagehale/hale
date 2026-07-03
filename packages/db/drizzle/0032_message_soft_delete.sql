-- Soft delete for conversation turns (additive only, rule #9). A parent may remove
-- a single turn — or erase the whole conversation — from /coach. A hard DELETE
-- would erase the row the audit trail references (rule #6, PIPEDA right-to-access),
-- so we stamp `deleted_at` instead: the read path (loadTimeline/loadTranscript)
-- filters it out, the row (and its audit history) stays intact. NULL = live, a
-- timestamp = removed by the parent. Same posture as family_memory_episodes (0026).
ALTER TABLE "messages" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
-- The transcript read path scans (conversation_id, created_at) and now also filters
-- deleted_at; index the pair the filtered read scans.
CREATE INDEX IF NOT EXISTS "messages_conversation_deleted_idx" ON "messages" USING btree ("conversation_id","deleted_at");
