-- VIL-597 · when a bounded family sweep last took each family, so a capped nightly
-- run rotates through every family instead of re-taking the oldest slice.
-- Additive (rule #9). New table only. Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS family_sweep_marks;

CREATE TABLE IF NOT EXISTS "family_sweep_marks" (
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"sweep" text NOT NULL,
	"swept_at" timestamp with time zone NOT NULL,
	CONSTRAINT "family_sweep_marks_family_id_sweep_pk" PRIMARY KEY ("family_id", "sweep")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "family_sweep_marks_sweep_idx" ON "family_sweep_marks" ("sweep","swept_at");--> statement-breakpoint
ALTER TABLE "family_sweep_marks" ENABLE ROW LEVEL SECURITY;
