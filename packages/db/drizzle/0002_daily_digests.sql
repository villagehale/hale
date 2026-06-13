CREATE TABLE "daily_digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"digest_date" date NOT NULL,
	"handled_count" integer DEFAULT 0 NOT NULL,
	"awaiting_count" integer DEFAULT 0 NOT NULL,
	"needs_you_count" integer DEFAULT 0 NOT NULL,
	"reverted_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_digests" ADD CONSTRAINT "daily_digests_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_digests_family_date_idx" ON "daily_digests" USING btree ("family_id","digest_date");