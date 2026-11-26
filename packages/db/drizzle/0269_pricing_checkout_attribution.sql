ALTER TABLE "pricing_checkout_payments"
  ADD COLUMN IF NOT EXISTS "attribution" text;
--> statement-breakpoint
ALTER TABLE "pricing_checkout_payments"
  ADD COLUMN IF NOT EXISTS "analytics_distinct_id" text;
