-- Non-transactional email send ledger + opt-outs (additive only, rule #9).
-- CASL: the daily brief is a non-transactional email, so each message needs
-- consent (an absent opt-out), sender identification, and a working unsubscribe.
-- email_sends records every accepted send (who + when); email_opt_outs records a
-- recipient's unsubscribe so the send path can refuse before sending. Both
-- cascade on the user/family so a deleted account leaves nothing behind (rule #1).
CREATE TYPE "public"."email_type" AS ENUM('daily_digest');--> statement-breakpoint
CREATE TABLE "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid,
	"user_id" uuid NOT NULL,
	"email_type" "email_type" NOT NULL,
	"recipient" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_message_id" text
);
--> statement-breakpoint
CREATE TABLE "email_opt_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email_type" "email_type" NOT NULL,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_opt_outs" ADD CONSTRAINT "email_opt_outs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_sends_user_type_idx" ON "email_sends" USING btree ("user_id","email_type");--> statement-breakpoint
CREATE UNIQUE INDEX "email_opt_outs_user_type_idx" ON "email_opt_outs" USING btree ("user_id","email_type");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0012/0019.
-- The app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "email_sends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_opt_outs" ENABLE ROW LEVEL SECURITY;
