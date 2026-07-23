-- VIL-229 (LLM voice layer) — week_plans.voice: the model-composed voice for a week
-- plan (warm greeting / week framing / per-item lines / sign-off) wrapped AROUND the
-- deterministic facts, never the facts themselves. Additive only (rule #9).
--
-- NULLABLE by construction (rule #8): the whole object is null when the voice stage is
-- disabled or degrades, and the deterministic plan (summary + items) still renders and
-- sends. The renderer uses a voice field where present, its deterministic copy where
-- not. Existing rows keep voice = NULL (pre-voice), which reads as the deterministic
-- plan — no backfill, no default needed.
ALTER TABLE "week_plans" ADD COLUMN "voice" jsonb;
