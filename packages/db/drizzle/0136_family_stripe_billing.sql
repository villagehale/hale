-- ENG-1 — Stripe customer/subscription ids on the family, and one year-retention
-- ask per household. Additive (rule #9). Reversible:
--   DROP TABLE IF EXISTS family_upgrade_offers;
--   DROP INDEX IF EXISTS families_stripe_subscription_id_uniq;
--   DROP INDEX IF EXISTS families_stripe_customer_id_uniq;
--   ALTER TABLE families DROP COLUMN IF EXISTS stripe_subscription_id;
--   ALTER TABLE families DROP COLUMN IF EXISTS stripe_customer_id;
-- Re-runnable: IF NOT EXISTS throughout.
ALTER TABLE "families" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "families" ADD COLUMN IF NOT EXISTS "stripe_subscription_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "families_stripe_customer_id_uniq"
  ON "families" ("stripe_customer_id")
  WHERE "stripe_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "families_stripe_subscription_id_uniq"
  ON "families" ("stripe_subscription_id")
  WHERE "stripe_subscription_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "family_upgrade_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "chat_id" text NOT NULL,
  "channel" text NOT NULL,
  "status" text NOT NULL,
  "asked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "answered_at" timestamp with time zone,
  "link_sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "family_upgrade_offers_channel_chk" CHECK ("channel" IN ('group', 'direct')),
  CONSTRAINT "family_upgrade_offers_status_chk" CHECK ("status" IN ('asked', 'declined', 'link_sent'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "family_upgrade_offers_family_uniq"
  ON "family_upgrade_offers" ("family_id");--> statement-breakpoint
ALTER TABLE "family_upgrade_offers" ENABLE ROW LEVEL SECURITY;
