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
  'drafted',
  'reviewed',
  // FIX 1: an approved, autonomy-qualified action checkpointed before the
  // executor send. Distinct from 'reviewed' (terminal for non-execute outcomes)
  // so a crash in the execute window is RESUMABLE, not silently dropped.
  'approved_pending_execute',
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
  // Scaffolded inbound legs — enum-recognised, webhook adapters return 501
  // (not_configured) until each leg's real API/OAuth + webhook secret arrives.
  'brightwheel', // daycare
  'himama', // daycare (now Lillio)
  'google_classroom', // school
  'gdrive', // Google Drive connector (read-only)
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
  'ask-hale',
  'daily-brief',
  'infer-memory',
  'discovery',
  'rank-recommendations',
  'curate-shortlist',
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
  // A parent's explicit, time-limited request to see a 13+ teen's redacted content
  // (rule #1 named exception). Written as a REQUEST (granted=false) with an expiry;
  // the teen is notified. The consume side (approving the request → granted=true,
  // and honouring an active grant on read) is a follow-up.
  'teen_content_access',
]);

// B18: family-level billing tier. Gates autonomous EXECUTION only — observe/draft
// is free for every stage and child. Values mirror @hale/types PlanTier.
export const planTierEnum = pgEnum('plan_tier', ['free', 'plus', 'family']);

// A child's gender, captured as an OPTIONAL onboarding field (rule #1: sensitive).
// Non-null with an explicit 'unspecified' default so a skipped answer is a value,
// not a SQL null. Values mirror @hale/types ChildGender.
export const childGenderEnum = pgEnum('child_gender', [
  'boy',
  'girl',
  'nonbinary',
  'unspecified',
]);

// The kind of email Hale sends, tracked in the send ledger + opt-out store so each
// row is honest about which stream it belongs to. 'daily_digest' is the
// non-transactional brief (CASL: needs an absent opt-out, sender id, working
// unsubscribe). 'welcome' is the transactional one-time onboarding email; its
// ledger row also keeps the send idempotent (one 'welcome' per user).
// 'verification' is the transactional email-confirmation link sent at sign-up; its
// ledger row makes the send auditable (PIPEDA right-to-access) like every stream.
export const emailTypeEnum = pgEnum('email_type', ['daily_digest', 'welcome', 'verification']);

// F11 · The Sunday Loop — a parent's chosen EXCHANGE channel (the two-way
// "reply to adjust" leg). Push is an always-on DELIVERY leg, not an exchange
// channel, so it is not a value here. Default 'email' — no provisioning gate;
// 'sms' lights up once the number is registered (founder decision 2026-07-21).
export const loopChannelEnum = pgEnum('loop_channel', ['email', 'sms']);

// How much of a child's identity a loop message body may carry — a PARENT'S
// choice, defaulting to the most private (rule #1). 'first_name' → "Maya",
// 'relation' → "your daughter/son" (from child gender; falls back to "your
// child"), 'generic' → "your kid". COMPOSES WITH the deterministic teen age gate:
// a 13+ child (deriveStage) is always forced to generic regardless of this pref.
export const childNameLevelEnum = pgEnum('child_name_level', [
  'first_name',
  'relation',
  'generic',
]);
