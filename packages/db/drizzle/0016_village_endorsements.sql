-- Hybrid trust + per-activity share (additive only, rule #9).
-- 1. A per-candidate public share token (the /a/:token single-activity card).
-- 2. village_endorsements: one row per family endorsing a candidate — the
--    trusted-parent signal. Only an AGGREGATE count is ever surfaced (rule #1).
ALTER TABLE "village_candidates" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "village_candidates" ADD CONSTRAINT "village_candidates_share_token_unique" UNIQUE("share_token");--> statement-breakpoint
CREATE TABLE "village_endorsements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"endorsed_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "village_endorsements" ADD CONSTRAINT "village_endorsements_candidate_id_village_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."village_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_endorsements" ADD CONSTRAINT "village_endorsements_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_endorsements" ADD CONSTRAINT "village_endorsements_endorsed_by_user_id_users_id_fk" FOREIGN KEY ("endorsed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "village_endorsements_candidate_family_idx" ON "village_endorsements" USING btree ("candidate_id","family_id");--> statement-breakpoint
CREATE INDEX "village_endorsements_candidate_idx" ON "village_endorsements" USING btree ("candidate_id");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0012. The app
-- connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "village_endorsements" ENABLE ROW LEVEL SECURITY;
