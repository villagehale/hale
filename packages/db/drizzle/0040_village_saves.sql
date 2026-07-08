-- village_saves: one row per family privately saving a candidate — the low-commitment
-- "I'm interested" bookmark (additive only, rule #9). PRIVATE by construction: unlike
-- endorsements (an aggregate public count) this is never surfaced to anyone but the
-- saving family. The unique (candidate_id, family_id) index makes saving idempotent so
-- a family saves a candidate at most once. Mirrors the 0016 endorsements convention.
CREATE TABLE "village_saves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"saved_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "village_saves" ADD CONSTRAINT "village_saves_candidate_id_village_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."village_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_saves" ADD CONSTRAINT "village_saves_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_saves" ADD CONSTRAINT "village_saves_saved_by_user_id_users_id_fk" FOREIGN KEY ("saved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "village_saves_candidate_family_idx" ON "village_saves" USING btree ("candidate_id","family_id");--> statement-breakpoint
CREATE INDEX "village_saves_candidate_idx" ON "village_saves" USING btree ("candidate_id");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0016. The app
-- connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "village_saves" ENABLE ROW LEVEL SECURITY;
