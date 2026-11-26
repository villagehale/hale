CREATE TABLE IF NOT EXISTS "pricing_checkout_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stripe_session_id" text NOT NULL,
  "tier" text NOT NULL,
  "sku" text,
  "currency" text,
  "phone_e164_encrypted" text,
  "phone_e164_hash" text,
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "bound_family_id" uuid REFERENCES "families"("id") ON DELETE set null,
  "bound_phone_e164_hash" text,
  "bound_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pricing_checkout_payments_tier_check" CHECK ("tier" IN ('plus', 'family'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pricing_checkout_payments_session_uniq"
  ON "pricing_checkout_payments" ("stripe_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_checkout_payments_phone_idx"
  ON "pricing_checkout_payments" ("phone_e164_hash");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pricing_checkout_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stripe_session_id" text NOT NULL REFERENCES "pricing_checkout_payments"("stripe_session_id") ON DELETE cascade,
  "phone_e164_encrypted" text NOT NULL,
  "phone_e164_hash" text NOT NULL,
  "code_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_checkout_codes_session_idx"
  ON "pricing_checkout_codes" ("stripe_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_checkout_codes_phone_idx"
  ON "pricing_checkout_codes" ("phone_e164_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pricing_checkout_codes_one_live"
  ON "pricing_checkout_codes" ("stripe_session_id") WHERE "consumed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "pricing_checkout_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricing_checkout_codes" ENABLE ROW LEVEL SECURITY;
