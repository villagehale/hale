-- VIL-729 · the one Stripe Checkout Session a family may still pay, and the adult who
-- opened it. Written only while ONE_OPEN_CHECKOUT_ENABLED is exactly `true`: a new
-- checkout for the family returns this session (same adult, same price) or expires it
-- in Stripe before making another. Both null = no session opened under the flag.
-- A Stripe session id and an internal user id only: no card, amount or name (rule #1).
--
-- Additive (rule #9): two nullable columns, nothing dropped or rewritten. Re-runnable:
-- ADD COLUMN IF NOT EXISTS. Reversible:
--   ALTER TABLE families DROP COLUMN IF EXISTS stripe_checkout_session_id;
--   ALTER TABLE families DROP COLUMN IF EXISTS stripe_checkout_opened_by;

ALTER TABLE "families" ADD COLUMN IF NOT EXISTS "stripe_checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "families" ADD COLUMN IF NOT EXISTS "stripe_checkout_opened_by" uuid;
