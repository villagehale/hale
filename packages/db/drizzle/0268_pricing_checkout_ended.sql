ALTER TABLE "pricing_checkout_payments"
  ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
