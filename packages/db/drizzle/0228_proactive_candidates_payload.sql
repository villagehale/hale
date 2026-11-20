-- VIL-612 · the remaining proactive classes hand a composed CTA to the hourly
-- decider. The sweep's after-send (an offer row, a booking, a watch close) lives
-- on this jsonb so the decider can run it after a verbatim send. Null on every
-- existing row and on kinds that need none. Add-only and nullable.
-- Reversible:
--   ALTER TABLE "proactive_candidates" DROP COLUMN "payload";
ALTER TABLE "proactive_candidates" ADD COLUMN IF NOT EXISTS "payload" jsonb;
