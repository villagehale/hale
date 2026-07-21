-- F11 · The Sunday Loop (VIL-213 · A2): the channel_messages ledger + the enum
-- values the loop dispatch needs. Additive only (rule #9).
--
-- channel_messages is the NEW operational system-of-record for LOOP messages, in
-- both directions and for EVERY outcome. It does NOT replace: email_sends (CASL
-- legal sub-ledger — a loop email writes BOTH), outbound_sends (executor domain,
-- untouched), push_sends (legacy debounce, untouched). `body` is populated for
-- direction 'in' ONLY (A3 writes it; C3's legal instrument) — outbound rows never
-- store a rendered child-data body (rule #1).
--
-- Loop email streams are added to email_type so a loop opt-out is distinct from
-- the daily-digest opt-out; sms_service_messages is the CASL express consent the
-- seam requires live before any SMS. Journal slot 0061 (pre-assigned to VIL-213);
-- sequenced after 0056 — 0057-0060 are sibling slots, so sequence order must place
-- whatever of those merged before this.
ALTER TYPE "public"."email_type" ADD VALUE 'weekly_plan';--> statement-breakpoint
ALTER TYPE "public"."email_type" ADD VALUE 'reminder';--> statement-breakpoint
ALTER TYPE "public"."email_type" ADD VALUE 'approval';--> statement-breakpoint
ALTER TYPE "public"."email_type" ADD VALUE 'alert';--> statement-breakpoint
ALTER TYPE "public"."consent_type" ADD VALUE 'sms_service_messages';--> statement-breakpoint
CREATE TYPE "public"."channel_message_channel" AS ENUM('email', 'sms', 'push');--> statement-breakpoint
CREATE TYPE "public"."channel_message_direction" AS ENUM('out', 'in');--> statement-breakpoint
CREATE TYPE "public"."channel_message_category" AS ENUM('weekly_plan', 'reminder', 'approval', 'alert', 'reply');--> statement-breakpoint
CREATE TYPE "public"."channel_message_status" AS ENUM('queued', 'sent', 'delivered', 'failed', 'suppressed_quiet_hours', 'suppressed_cap', 'suppressed_consent', 'suppressed_pref');--> statement-breakpoint
CREATE TABLE "channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"parent_user_id" uuid NOT NULL,
	"channel" "public"."channel_message_channel" NOT NULL,
	"direction" "public"."channel_message_direction" DEFAULT 'out' NOT NULL,
	"category" "public"."channel_message_category" NOT NULL,
	"template_key" text,
	"dedupe_key" text,
	"provider_message_id" text,
	"status" "public"."channel_message_status" NOT NULL,
	"error_code" text,
	"body" text,
	"related_action_id" uuid,
	"related_conversation_id" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_parent_user_id_users_id_fk" FOREIGN KEY ("parent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_related_action_id_actions_id_fk" FOREIGN KEY ("related_action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_related_conversation_id_conversations_id_fk" FOREIGN KEY ("related_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_messages_dedupe_key_uniq" ON "channel_messages" USING btree ("dedupe_key") WHERE "dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "channel_messages_provider_msg_idx" ON "channel_messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "channel_messages_cap_idx" ON "channel_messages" USING btree ("parent_user_id","category","created_at");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0040/0041/0056.
-- The app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "channel_messages" ENABLE ROW LEVEL SECURITY;
