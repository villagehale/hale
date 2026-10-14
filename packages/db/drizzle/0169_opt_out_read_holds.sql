-- #868 · a sender whose opt-out read failed twice is held from proactive and queued
-- outbound until a read succeeds. Additive (rule #9). Numbered 0169: 0166-0168 are
-- taken by #862, #861 and VIL-131.
CREATE TABLE IF NOT EXISTS "opt_out_read_holds" (
	"phone_hash" text PRIMARY KEY NOT NULL,
	"held_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Server-only (no app policy): RLS on, like every table since the frozen legacy list.
ALTER TABLE "opt_out_read_holds" ENABLE ROW LEVEL SECURITY;
