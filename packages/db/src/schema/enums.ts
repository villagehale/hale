import { pgEnum } from 'drizzle-orm/pg-core';

export const familyRoleEnum = pgEnum('family_role', [
  'primary_parent',
  'co_parent',
  'extended',
  'service',
]);

export const onboardingStageEnum = pgEnum('onboarding_stage', [
  'pending_invite',
  'profile_setup',
  'integrations_connect',
  'observation_mode', // L1: observe-only first 7 days
  'drafts_mode', // L2: drafts for approval
  'autonomous_mode', // L3+: routine autonomous
]);

export const eventStatusEnum = pgEnum('event_status', [
  'pending',
  'classified',
  'routed',
  'actioned',
  'ignored',
  'failed',
]);

export const reviewerVerdictEnum = pgEnum('reviewer_verdict', [
  'pending',
  'approved',
  'rejected',
  'flagged',
  'superseded',
]);

export const actionUserVisibleStateEnum = pgEnum('action_user_visible_state', [
  'autonomous',
  'drafted_for_approval',
  'needs_human',
  'reverted',
]);

export const integrationProviderEnum = pgEnum('integration_provider', [
  'gmail',
  'outlook',
  'gcal',
  'apple_cal',
  'google_photos',
  'icloud_photos',
  'stripe',
  'twilio',
  'cra',
  'esdc',
  'pediatric_portal',
]);

export const integrationStatusEnum = pgEnum('integration_status', [
  'connecting',
  'active',
  'expired',
  'revoked',
  'error',
]);

export const memoryFactTypeEnum = pgEnum('memory_fact_type', [
  'preference',
  'routine',
  'medical',
  'logistic',
  'relationship',
  'voice',
]);

export const agentNameEnum = pgEnum('agent_name', [
  'classifier',
  'drafter',
  'coach',
  'reviewer',
  'memory_inferencer',
]);

export const agentRunStatusEnum = pgEnum('agent_run_status', [
  'in_progress',
  'completed',
  'failed',
  'timed_out',
  'killed_cost',
]);

export const consentTypeEnum = pgEnum('consent_type', [
  'terms_of_service',
  'privacy_policy',
  'cross_border_data',
  'llm_processing',
  'integration_specific',
  'autonomous_action_class',
]);
