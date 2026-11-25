-- VIL-729 · the one Stripe Checkout Session a family may still pay, and the adult who
-- opened it. One row per family, written only while ONE_OPEN_CHECKOUT_ENABLED is exactly
-- `true`: a new checkout for the family returns this session (same adult, same price) or
-- expires it in Stripe before making another. No row = no session opened under the flag.
-- A Stripe session id and an internal user id only: no card, amount or name (rule #1).
-- A table of its own, not columns on families: Drizzle names every families column on
-- every insert, so a families column would break family creation on any database the
-- code reaches before this migration does.
--
-- Additive (rule #9): a new table, nothing dropped or rewritten. Erased with its family
-- (ON DELETE CASCADE). Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS family_open_checkouts;

CREATE TABLE IF NOT EXISTS "family_open_checkouts" (
	"family_id" uuid PRIMARY KEY NOT NULL REFERENCES "families"("id") ON DELETE CASCADE,
	"session_id" text NOT NULL,
	"opened_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "family_open_checkouts" ENABLE ROW LEVEL SECURITY;
