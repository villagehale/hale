-- Founding-family badge + retention substrate. Additive only (rule #9).
--   1. families.founding_number — permanent first-100 ordinal. Backfilled for
--      every existing family by created_at (all rows to date are founding), then
--      assigned in-app at provisioning. Unique so two families can never share a
--      number; the assignment path treats a violation as "badge forfeited",
--      never as a failed onboarding.
--   2. family_active_days — one row per family per Toronto-local day the app was
--      opened (upsert-on-conflict from the authed layout). Day-grain only: no
--      content, no user identity (rule #1). Powers "opened 3+ times in 14 days".
ALTER TABLE "families" ADD COLUMN "founding_number" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "families_founding_number_unique" ON "families" ("founding_number");--> statement-breakpoint
UPDATE "families" f SET "founding_number" = r.rank
FROM (SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS rank FROM "families") r
WHERE f.id = r.id;--> statement-breakpoint
CREATE TABLE "family_active_days" (
	"family_id" uuid NOT NULL,
	"day" date NOT NULL,
	CONSTRAINT "family_active_days_family_id_day_pk" PRIMARY KEY("family_id","day")
);--> statement-breakpoint
ALTER TABLE "family_active_days" ADD CONSTRAINT "family_active_days_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_active_days" ENABLE ROW LEVEL SECURITY;
