-- Village intros v1 — double-opt-in, activity-anchored introductions between two Hale
-- families. Additive only (rule #9): two enum values and one new table. Nothing is
-- dropped and no existing value changes meaning.
--
-- No data uses either new enum value in this transaction — the new table stores no
-- literal of either type — so ADD VALUE is safe alongside the CREATE TABLE (the 0072
-- precedent).
ALTER TYPE "public"."consent_type" ADD VALUE IF NOT EXISTS 'village_intro';--> statement-breakpoint
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'village_intro';--> statement-breakpoint
-- One row is one PAIR. `family_a_id < family_b_id` is a CHECK rather than a convention
-- so the same two families cannot be stored twice in mirror order — which is what makes
-- the partial unique index below actually mean "at most one open proposal per pair", and
-- what makes "have these two been paired before?" a single lookup.
--
-- Nothing a parent reads is stored here: no names, no numbers, no bodies. Each side's
-- card is composed at send time from that side's OWN rows (rule #1).
CREATE TABLE IF NOT EXISTS "village_intro_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fsa" text NOT NULL,
	"status" text NOT NULL,
	"stage" text NOT NULL,
	"civic_session_id" uuid,
	"family_a_id" uuid NOT NULL,
	"family_b_id" uuid NOT NULL,
	"family_a_child_id" uuid,
	"family_b_child_id" uuid,
	"family_a_asked_at" timestamp with time zone,
	"family_b_asked_at" timestamp with time zone,
	"family_a_reply" text,
	"family_b_reply" text,
	"family_a_replied_at" timestamp with time zone,
	"family_b_replied_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "village_intro_proposals_ordered_pair" CHECK ("family_a_id" < "family_b_id")
);
--> statement-breakpoint
ALTER TABLE "village_intro_proposals" ADD CONSTRAINT "village_intro_proposals_civic_session_id_civic_sessions_id_fk" FOREIGN KEY ("civic_session_id") REFERENCES "public"."civic_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_intro_proposals" ADD CONSTRAINT "village_intro_proposals_family_a_id_families_id_fk" FOREIGN KEY ("family_a_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_intro_proposals" ADD CONSTRAINT "village_intro_proposals_family_b_id_families_id_fk" FOREIGN KEY ("family_b_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_intro_proposals" ADD CONSTRAINT "village_intro_proposals_family_a_child_id_children_id_fk" FOREIGN KEY ("family_a_child_id") REFERENCES "public"."children"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_intro_proposals" ADD CONSTRAINT "village_intro_proposals_family_b_child_id_children_id_fk" FOREIGN KEY ("family_b_child_id") REFERENCES "public"."children"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "village_intro_proposals_open_pair_idx" ON "village_intro_proposals" USING btree ("family_a_id","family_b_id") WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "village_intro_proposals_family_a_idx" ON "village_intro_proposals" USING btree ("family_a_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "village_intro_proposals_family_b_idx" ON "village_intro_proposals" USING btree ("family_b_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "village_intro_proposals_fsa_status_idx" ON "village_intro_proposals" USING btree ("fsa","status");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0051/0058. The app
-- connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1 — a row that
-- names two households and the area they share must never be reachable through it.
ALTER TABLE "village_intro_proposals" ENABLE ROW LEVEL SECURITY;
