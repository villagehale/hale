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
  // CASL express consent to receive SMS service messages (weekly plan, reminders,
  // approvals) on a verified phone. Per-PARENT, not per-family — co-parents enroll
  // independently, so this never triggers the two-parent-consent rule (#5). Granted
  // on OTP verify; a granted=false row records a withdrawal (in-app toggle / STOP).
  // The channel seam (VIL-213) gates SMS on the live parent_channels state, not on
  // this append-only ledger.
  'sms_service_messages',
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
export const emailTypeEnum = pgEnum('email_type', [
  'daily_digest',
  'welcome',
  'verification',
  // F11 loop email streams (VIL-213): a loop email writes an email_sends row
  // alongside channel_messages so CASL opt-outs distinguish loop mail from the
  // daily digest. One value per loop category so opt-out granularity matches
  // loop_prefs' per-category model.
  'weekly_plan',
  'reminder',
  'approval',
  'alert',
]);

// How a family_events row entered the loop's shared "external events" home (VIL-217).
// 'parent' — a parent added it directly in-app. 'channel' — extracted from a reply
// on the exchange channel (C2 "add Leo's party Sat 2pm"). 'email' — pulled from an
// invite email (E-phase). The composer treats all three identically; the source is
// kept for provenance + audit (rule #6).
export const familyEventSourceEnum = pgEnum('family_event_source', [
  'parent',
  'channel',
  'email',
  // A Hale-authored calendar PLACEMENT (VIL-219 calendar_add) — distinct from the
  // three EXTERNAL-occasion sources above. The weekly-plan composer surfaces external
  // occasions but NOT placements (a placed item is a durable calendar entry, not a
  // fresh proposal), while the ICS feed renders both.
  'placement',
]);

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

// F11 · The Sunday Loop — the channel_messages ledger (VIL-213 · A2). One message
// model, many pipes: the delivery leg a row rode on.
export const channelMessageChannelEnum = pgEnum('channel_message_channel', [
  'email',
  'sms',
  'push',
]);

// Direction of a loop message. 'in' rows (replies) are the ONLY rows that carry a
// verbatim body (A3 writes it; C3 treats it as the approval's legal instrument).
export const channelMessageDirectionEnum = pgEnum('channel_message_direction', ['out', 'in']);

// The loop taxonomy a message belongs to (mirrors loop_prefs categories, plus the
// inbound 'reply'). Enforcement (enable/quiet/cap) keys off this.
export const channelMessageCategoryEnum = pgEnum('channel_message_category', [
  'weekly_plan',
  'reminder',
  'approval',
  'alert',
  'reply',
]);

// Every outcome the dispatch records — a delivered/failed send OR a suppression.
// A ledger row is written for EACH, so the record is a complete accounting of what
// the seam did and why (rule #6 + operational truth).
export const channelMessageStatusEnum = pgEnum('channel_message_status', [
  'queued',
  'sent',
  'delivered',
  'failed',
  'suppressed_quiet_hours',
  'suppressed_cap',
  'suppressed_consent',
  'suppressed_pref',
]);
