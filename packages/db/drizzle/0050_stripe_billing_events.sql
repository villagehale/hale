-- Stripe billing-event idempotency ledger (B18, additive only — rule #9). Stripe
-- delivers each webhook event at-least-once and retries on any non-2xx; the billing
-- handler claims the event id here inside the same transaction that writes
-- families.plan_tier, so a redelivered event conflicts on the unique index instead of
-- applying the tier transition (and its audit_log row) twice. Same claim-row idiom as
-- outbound_sends. Inert until Stripe keys exist (the webhook 501s while not live).
CREATE TABLE "stripe_billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_billing_events_event_idx" ON "stripe_billing_events" USING btree ("event_id");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0012/0019/0020.
-- The app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "stripe_billing_events" ENABLE ROW LEVEL SECURITY;
