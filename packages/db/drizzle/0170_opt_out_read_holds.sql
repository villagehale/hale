-- #868 · a sender whose opt-out read failed twice is held from proactive and queued
-- outbound until a read succeeds. Additive (rule #9). Numbered 0170: 0166 #862, 0167 #861,
-- 0168 VIL-131, 0169 #855 (kid_relevance_verdicts).
CREATE TABLE IF NOT EXISTS "opt_out_read_holds" (
	"phone_hash" text PRIMARY KEY NOT NULL,
	"held_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Server-only (no app policy): RLS on, like every table since the frozen legacy list.
ALTER TABLE "opt_out_read_holds" ENABLE ROW LEVEL SECURITY;
