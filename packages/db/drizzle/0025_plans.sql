-- Parent-authored plans (additive only, rule #9). A private note the parent
-- writes for their week — distinct from the agent-proposed routine/candidates.
-- family_id scopes the row to the family (cascade), created_by is the authoring
-- parent (users.id, cascade), child_id is NULLABLE: NULL = whole family, set =
-- one child (cascade so a removed child takes its plans). `private` defaults
-- true and is the only mode today — public discovery is deferred, so a plan is
-- never reachable outside the family (rule #1).
CREATE TABLE IF NOT EXISTS "family_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"child_id" uuid,
	"title" text NOT NULL,
	"notes" text,
	"scheduled_for" timestamp with time zone,
	"private" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "family_plans" ADD CONSTRAINT "family_plans_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "family_plans" ADD CONSTRAINT "family_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "family_plans" ADD CONSTRAINT "family_plans_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "family_plans_family_idx" ON "family_plans" USING btree ("family_id");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0024. The app
-- connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1 — a
-- parent's plan must never be reachable through the public Data API.
ALTER TABLE "family_plans" ENABLE ROW LEVEL SECURITY;
