ALTER TABLE "events" ADD COLUMN "child_id" uuid;--> statement-breakpoint
ALTER TABLE "daily_digests" ADD COLUMN "per_child_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE set null ON UPDATE no action;