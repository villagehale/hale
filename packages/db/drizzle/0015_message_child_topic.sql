ALTER TABLE "messages" ADD COLUMN "child_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "topic" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE set null ON UPDATE no action;
