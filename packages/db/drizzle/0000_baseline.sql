CREATE TYPE "public"."action_user_visible_state" AS ENUM('autonomous', 'drafted_for_approval', 'needs_human', 'reverted');--> statement-breakpoint
CREATE TYPE "public"."agent_name" AS ENUM('classifier', 'drafter', 'coach', 'reviewer', 'memory_inferencer');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('in_progress', 'completed', 'failed', 'timed_out', 'killed_cost');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('terms_of_service', 'privacy_policy', 'cross_border_data', 'llm_processing', 'integration_specific', 'autonomous_action_class');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('pending', 'classified', 'drafted', 'reviewed', 'approved_pending_execute', 'routed', 'actioned', 'ignored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."family_role" AS ENUM('primary_parent', 'co_parent', 'extended', 'service');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('gmail', 'outlook', 'gcal', 'apple_cal', 'google_photos', 'icloud_photos', 'stripe', 'twilio', 'cra', 'esdc', 'pediatric_portal');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('connecting', 'active', 'expired', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."memory_fact_type" AS ENUM('preference', 'routine', 'medical', 'logistic', 'relationship', 'voice');--> statement-breakpoint
CREATE TYPE "public"."onboarding_stage" AS ENUM('pending_invite', 'profile_setup', 'integrations_connect', 'observation_mode', 'drafts_mode', 'autonomous_mode');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('free', 'plus', 'family');--> statement-breakpoint
CREATE TYPE "public"."reviewer_verdict" AS ENUM('pending', 'approved', 'rejected', 'flagged', 'superseded');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"locale" text DEFAULT 'en-CA' NOT NULL,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"external_auth_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_external_auth_id_unique" UNIQUE("external_auth_id")
);
--> statement-breakpoint
CREATE TABLE "families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"country_code" text DEFAULT 'CA' NOT NULL,
	"province_or_state" text,
	"primary_language" text DEFAULT 'en' NOT NULL,
	"onboarding_stage" "onboarding_stage" DEFAULT 'pending_invite' NOT NULL,
	"plan_tier" "plan_tier" DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_members" (
	"family_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "family_role" NOT NULL,
	"invited_by_user_id" uuid,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_members_family_id_user_id_pk" PRIMARY KEY("family_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "children" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"name" text NOT NULL,
	"date_of_birth" date NOT NULL,
	"biological_sex" text,
	"gestational_weeks" integer,
	"birth_weight_g" integer,
	"hospital_of_birth" text,
	"parenting_style_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"user_id" uuid,
	"provider" "integration_provider" NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"oauth_tokens_encrypted" text,
	"provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "integration_status" DEFAULT 'connecting' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid,
	"user_id" uuid NOT NULL,
	"consent_type" "consent_type" NOT NULL,
	"consent_scope" text,
	"granted" boolean NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"policy_version" text NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "family_memory_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"child_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"episode_type" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_event_id" uuid,
	"sentiment_score" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_memory_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"child_id" uuid,
	"fact_type" "memory_fact_type" NOT NULL,
	"fact_key" text NOT NULL,
	"fact_value" jsonb NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"source_event_id" uuid,
	"inferred_by" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_voice_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"voice_samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tone_descriptors" text[] DEFAULT '{}' NOT NULL,
	"signature_block" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_external_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"classifier_suggestion" jsonb,
	"raw_signal_ref" text,
	"classified_at" timestamp with time zone,
	"classifier_confidence" double precision,
	"dedup_hash" text NOT NULL,
	"status" "event_status" DEFAULT 'pending' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"drafted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drafted_by_agent_run_id" uuid,
	"reviewer_verdict" "reviewer_verdict" DEFAULT 'pending' NOT NULL,
	"reviewer_verdict_at" timestamp with time zone,
	"reviewer_tool_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"executed_at" timestamp with time zone,
	"executor_result" jsonb,
	"user_visible_state" "action_user_visible_state" DEFAULT 'drafted_for_approval' NOT NULL,
	"reverted_at" timestamp with time zone,
	"reverted_reason" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action_taken" text NOT NULL,
	"target_table" text,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"agent_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"event_id" uuid,
	"action_id" uuid,
	"agent_name" "agent_name" NOT NULL,
	"model_used" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"prompt_cache_hit" boolean,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"status" "agent_run_status" DEFAULT 'in_progress' NOT NULL,
	"parent_run_id" uuid,
	"langfuse_trace_id" text
);
--> statement-breakpoint
CREATE TABLE "outbound_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"provider_message_id" text
);
--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "children" ADD CONSTRAINT "children_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_memory_episodes" ADD CONSTRAINT "family_memory_episodes_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_memory_episodes" ADD CONSTRAINT "family_memory_episodes_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_memory_facts" ADD CONSTRAINT "family_memory_facts_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_memory_facts" ADD CONSTRAINT "family_memory_facts_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_voice_profiles" ADD CONSTRAINT "family_voice_profiles_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_voice_profiles" ADD CONSTRAINT "family_voice_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_external_auth_idx" ON "users" USING btree ("external_auth_id");--> statement-breakpoint
CREATE INDEX "family_members_user_idx" ON "family_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "children_family_idx" ON "children" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "integrations_family_provider_idx" ON "integrations" USING btree ("family_id","provider");--> statement-breakpoint
CREATE INDEX "consent_user_type_idx" ON "consent_records" USING btree ("user_id","consent_type");--> statement-breakpoint
CREATE INDEX "memory_episodes_family_time_idx" ON "family_memory_episodes" USING btree ("family_id","occurred_at");--> statement-breakpoint
CREATE INDEX "memory_facts_lookup_idx" ON "family_memory_facts" USING btree ("family_id","fact_type","fact_key") WHERE "family_memory_facts"."valid_until" IS NULL;--> statement-breakpoint
CREATE INDEX "memory_facts_child_idx" ON "family_memory_facts" USING btree ("child_id");--> statement-breakpoint
CREATE INDEX "voice_profile_family_user_idx" ON "family_voice_profiles" USING btree ("family_id","user_id");--> statement-breakpoint
CREATE INDEX "events_family_status_idx" ON "events" USING btree ("family_id","status","classified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_dedup_idx" ON "events" USING btree ("family_id","dedup_hash");--> statement-breakpoint
CREATE INDEX "actions_family_state_idx" ON "actions" USING btree ("family_id","user_visible_state","drafted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "actions_event_idx" ON "actions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "audit_log_family_time_idx" ON "audit_log" USING btree ("family_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_runs_family_cost_idx" ON "agent_runs" USING btree ("family_id","started_at","cost_usd");--> statement-breakpoint
CREATE INDEX "agent_runs_event_idx" ON "agent_runs" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_sends_action_idx" ON "outbound_sends" USING btree ("action_id");