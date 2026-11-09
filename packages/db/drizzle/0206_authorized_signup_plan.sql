-- VIL-558 · the day-before plan. The parent approves the child (the offer's), ranked
-- session choices, a maximum price and whether Hale may tick the provider's activity
-- waiver; at the open Hale carries the plan out with no further yes. Session ids and
-- the price only, never a child or a parent. Additive (rule #9), nullable: an offer
-- that was never planned has none. Re-runnable: every statement is IF [NOT] EXISTS or
-- a DO block.
--
-- status gains the value 'planned'. The CHECK is loosened under its own name (0137
-- creates it inline, so a replay of 0137 is a no-op and never puts the tighter list
-- back). DROP and ADD share one block, so a hand-apply never leaves the table with
-- neither; NOT VALID because every existing row already holds one of the old values.
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "plan_choice_ids" text[];
--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "plan_max_price_cents" integer;
--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "plan_opens_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "plan_waiver_accepted" boolean;
--> statement-breakpoint
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "plan_approved_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authorized_signup_offers_planned_idx" ON "authorized_signup_offers" ("plan_opens_at") WHERE "status" = 'planned';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "authorized_signup_offers" DROP CONSTRAINT IF EXISTS "authorized_signup_offers_status_chk";
  ALTER TABLE "authorized_signup_offers" ADD CONSTRAINT "authorized_signup_offers_status_chk"
    CHECK ("status" IN ('pending', 'planned', 'submitting', 'completed', 'handed_back')) NOT VALID;
END $$;
