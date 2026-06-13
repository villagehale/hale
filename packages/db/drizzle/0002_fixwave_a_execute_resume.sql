-- Fix-wave A reliability migration. ADDITIVE ONLY (hard rule #9): one new enum
-- value and one new unique index. No drops, no type changes, no narrowing.
--
-- Hand-authored (drizzle-kit generate is broken in this repo — see
-- 0000_b8910_reliability.sql for the same pattern).

-- FIX 1: a resumable pre-executor checkpoint. An approved, autonomy-qualified
-- action that crashes between review and the executor send now sits at
-- 'approved_pending_execute' (RESUMABLE) instead of 'reviewed' (terminal), so a
-- pg-boss redelivery re-drives the executor instead of silently dropping the
-- send. ALTER TYPE ... ADD VALUE is non-destructive.
ALTER TYPE "event_status" ADD VALUE IF NOT EXISTS 'approved_pending_execute' AFTER 'reviewed';
--> statement-breakpoint

-- FIX 2: exactly one action per event. A crash between recordAction and the
-- next checkpoint must not let a redelivery mint a phantom duplicate action
-- row. The unique index is the backstop behind recordAction's
-- onConflictDoNothing(event_id). On a populated DB this fails if pre-existing
-- duplicates exist — none can have shipped on this pre-launch rebuild branch.
CREATE UNIQUE INDEX IF NOT EXISTS "actions_event_idx" ON "actions" ("event_id");
