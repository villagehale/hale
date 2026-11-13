-- VIL-689 · one plan-identity rule for group chats. A chat may hold several open plans: a new
-- event no longer closes a plan that is still ahead, so the one-open-plan-per-chat unique index
-- becomes a plain lookup index (no row changes; every standing row already satisfies it). A
-- ride records, once, whether it was made in a household group or a chat several families
-- share, so a later roster change can never drop the 1:1 consent gate.
DROP INDEX IF EXISTS "linq_group_plans_live_chat_uniq";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linq_group_plans_open_chat_idx" ON "linq_group_plans" USING btree ("chat_id") WHERE "closed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "linq_group_carpools" ADD COLUMN IF NOT EXISTS "chat_audience" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "linq_group_carpools" ADD CONSTRAINT "linq_group_carpools_chat_audience_check" CHECK ("chat_audience" IS NULL OR "chat_audience" in ('household', 'shared'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
