-- VIL-553 · a held text read late as a stop, whose stop was applied (revoked, withdrawn)
-- while its confirmation waits for the family's own morning. Set means the stop took effect
-- then and only the courtesy text is still owed. Additive (rule #9), nullable: every other
-- held row has none.
ALTER TABLE "opt_out_held_messages" ADD COLUMN IF NOT EXISTS "stop_applied_at" timestamp with time zone;
