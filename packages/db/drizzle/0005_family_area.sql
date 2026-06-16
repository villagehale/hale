ALTER TABLE "families" ADD COLUMN "area_coarse" text;--> statement-breakpoint
ALTER TABLE "children" ADD COLUMN "interests" jsonb DEFAULT '[]'::jsonb NOT NULL;
