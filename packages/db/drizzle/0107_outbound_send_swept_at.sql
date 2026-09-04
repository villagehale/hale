-- Executor claim residue made observable (audit P1-6). An outbound_sends row is the
-- claim-before-send idempotency gate; sent_at is stamped only after the provider
-- confirms. A crash between the two leaves a claim nothing will ever confirm — and the
-- redelivery that follows reads the existing claim as "already sent" and marks the
-- action done, so an approved email that never went out was structurally
-- indistinguishable from one that did (rule #11: no reader anywhere selected
-- sent_at-null rows). swept_at is the delivery-truth sweep's own claim on REPORTING
-- that residue: stamped once under WHERE swept_at IS NULL, so one stale claim is one
-- audit row, not one per tick. Additive only; the executor never reads it.
ALTER TABLE "public"."outbound_sends"
  ADD COLUMN IF NOT EXISTS "swept_at" timestamp with time zone;
--> statement-breakpoint
-- The sweep's working set: unconfirmed, unreported claims. Partial, so the index
-- holds only residue — in a healthy system, nothing.
CREATE INDEX IF NOT EXISTS "outbound_sends_unconfirmed_idx"
  ON "public"."outbound_sends" ("claimed_at")
  WHERE "sent_at" IS NULL AND "swept_at" IS NULL;
