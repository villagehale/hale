-- VIL-689 · group plan identity, additive only. A ride records, once, whether it was made in a
-- household group or a chat several families share, so a later roster change can never drop
-- the 1:1 consent gate. A calendar ask records the which-plan line it was last put in, with
-- every plan that line asked about, so a reply binds only among those plans, and the parent
-- who gave the OK, so a moved-copy notice reaches that parent. The one-open-plan-per-chat
-- unique index stays: a later migration replaces it when LINQ_GROUP_SCENES_ENABLED is lit.
ALTER TABLE "linq_group_carpools" ADD COLUMN IF NOT EXISTS "chat_audience" text;--> statement-breakpoint
ALTER TABLE "linq_group_plan_calendar_consents" ADD COLUMN IF NOT EXISTS "which_line" jsonb;--> statement-breakpoint
ALTER TABLE "linq_group_plan_calendar_consents" ADD COLUMN IF NOT EXISTS "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "linq_group_carpools" ADD CONSTRAINT "linq_group_carpools_chat_audience_check" CHECK ("chat_audience" IS NULL OR "chat_audience" in ('household', 'shared'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
