CREATE TYPE "public"."child_gender" AS ENUM('boy', 'girl', 'nonbinary', 'unspecified');--> statement-breakpoint
ALTER TABLE "children" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "children" ADD COLUMN "gender" "child_gender" DEFAULT 'unspecified' NOT NULL;
