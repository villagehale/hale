-- The voice pass's aside gets its own agent_runs name. Additive (rule #9).
--
-- Not folded into an existing name: this is a per-alert Haiku call on the highest-volume
-- proactive class, and it is the one composer whose justification is marginal enough that
-- "what did it cost, and how often was it refused" has to be answerable from the database
-- rather than from a cron summary nobody keeps.
--
-- `IF NOT EXISTS` because the Deploy migrate leg re-runs everything past the ledger
-- watermark, and a bare ADD VALUE raises on the second pass.
ALTER TYPE "public"."agent_name" ADD VALUE IF NOT EXISTS 'voice-pass';
