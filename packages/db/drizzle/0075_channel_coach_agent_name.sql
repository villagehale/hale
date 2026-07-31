-- VIL-221 (C2 · channel coach runtime) — one additive enum value, nothing else.
-- Additive only (rule #9): existing values are untouched, and ADD VALUE does not use
-- the new value in this transaction, so it is safe (same shape as 0070 / 0071).
--
-- An SMS turn is its own agent_runs row rather than a reuse of 'ask-hale' because the
-- two surfaces have different cost and latency profiles over the same brain — the
-- channel turn is non-streaming, tool-heavy, and gated on a p50 the app's Ask is not.
-- Sharing the name would average them into a number that describes neither.
ALTER TYPE "public"."agent_name" ADD VALUE IF NOT EXISTS 'coach-channel-sms';
