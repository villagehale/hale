-- family_events: the loop's shared "external events" home (VIL-217) — occasions with
-- no other model in Hale (a friend's birthday party, a family gathering). Additive only
-- (rule #9). The weekly-plan composer READS in-window rows here now; the WRITE paths land
-- later (C2 turns a channel reply "add Leo's party Sat 2pm" into a row; the E-phase pulls
-- them from invite emails). `source` records which entered it.
--
-- `starts_at` is the event start INSTANT (timestamptz); the composer buckets an event into
-- a week by its FAMILY-LOCAL calendar day (dayKeyIn(starts_at, family_tz)), so a stored
-- instant lands on the correct local day across DST and zones. Family-scoped by
-- construction (rule #1): every read is keyed on family_id, FK cascades on family
-- deletion. child_id is nullable — set when the event concerns one child (so the composer
-- can apply the teen age gate), null for a family-wide occasion.
CREATE TABLE "family_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"child_id" uuid,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"location" text,
	"source" "family_event_source" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_events" ADD CONSTRAINT "family_events_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- child_id nulls (not deletes) when the child is removed — the event survives.
ALTER TABLE "family_events" ADD CONSTRAINT "family_events_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- created_by nulls (not deletes) when the acting user is removed.
ALTER TABLE "family_events" ADD CONSTRAINT "family_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The composer scans WHERE family_id = ? AND starts_at IN [window]; index the pair.
CREATE INDEX "family_events_family_starts_idx" ON "family_events" USING btree ("family_id","starts_at");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as every table. Rule #1.
ALTER TABLE "family_events" ENABLE ROW LEVEL SECURITY;
