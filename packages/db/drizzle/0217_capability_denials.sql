-- VIL-303 · a "not something I can do yet" Hale told one parent, kept so the next text
-- that parent opens can carry the correction once the capability is real.
-- Additive (rule #9). New table only. Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS capability_denials;

CREATE TABLE IF NOT EXISTS "capability_denials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"capability" text NOT NULL,
	"denied_in" text NOT NULL,
	"denied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"corrected_at" timestamp with time zone,
	"corrected_by" text,
	CONSTRAINT "capability_denials_closure_check" CHECK (("corrected_at" IS NULL) = ("corrected_by" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "capability_denials_open_uniq" ON "capability_denials" ("user_id","capability") WHERE "corrected_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "capability_denials_family_idx" ON "capability_denials" ("family_id");--> statement-breakpoint
ALTER TABLE "capability_denials" ENABLE ROW LEVEL SECURITY;
