import { pgEnum } from 'drizzle-orm/pg-core';

export const familyRoleEnum = pgEnum('family_role', [
  'primary_parent',
  'co_parent',
  'extended',
  'service',
  // VIL-241 · M6 — the NAMED caregiver roles. 'extended' and 'service' were the
  // original vague buckets and are deliberately left in place (rule #9: nothing is
  // dropped), but no flow grants them and they carry NO scope: a role is a redaction
  // level (apps/web/lib/channel/role-scope.ts), and a bucket whose meaning nobody can
  // state cannot have one. New grants use these three.
  'grandparent',
  'nanny',
  'babysitter',
]);

export const onboardingStageEnum = pgEnum('onboarding_stage', [
  'pending_invite',
  'profile_setup',
  'integrations_connect',
  'observation_mode', // L1: observe-only first 7 days
  'drafts_mode', // L2: drafts for approval
  'autonomous_mode', // L3+: routine autonomous
  // VIL-237 · the SMS-first intake (the phone number IS the account). The family is
  // provisioned into 'sms_intake' the moment the details land, and moves to
  // 'sms_active' only once the watch-offer has been ANSWERED — so the stage itself
  // records whether proactive contact was ever agreed to, rather than inferring it.
  'sms_intake',
  'sms_active',
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
  'weekly-plan-voice',
  'welcome-voice',
  'reminder-voice',
  'radar-voice',
  'nudge-voice',
  'coach-channel-sms',
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
  // A parent authorizing a named third-party MCP client to receive only the
  // explicitly selected Hale scopes. Revocation appends granted=false; the
  // mcp_grants row is the live enforcement seam.
  'mcp_third_party_model',
  // VIL-237: the parent's answer to the intake watch-offer ("want me to keep an eye
  // on all of this for you?"). Distinct from sms_service_messages (permission to USE
  // the channel) and from autonomous_action_class (permission to ACT): this is
  // permission to watch UNPROMPTED and text when something matters. Read from free
  // text, so the row always carries `evidence` — the verbatim reply plus the
  // interpretation made of it. A decline appends granted=false.
  'proactive_watch',
  // VIL-241 · the PARENT's authorization to disclose a scoped slice of their family's
  // week to a NAMED third party (a grandparent/nanny/babysitter) on a NAMED number.
  // Disclosure to someone outside the household is a decision only a parent can make,
  // so it is its own record — never inferred from the family_members row.
  'caregiver_access_grant',
  // VIL-241 · the CAREGIVER's OWN CASL express consent to be texted, given by replying
  // to the invite from the number itself. Distinct from sms_service_messages (a
  // parent's channel consent): the scope column carries the ROLE, because what they
  // agreed to receive is defined by that role's scope and nothing wider.
  'caregiver_scoped_messages',
  // Village intros v1 · the parent's decision about being INTRODUCED to another Hale
  // household. Two scopes ride this one type and they are different acts: the standing
  // "you may look for a match for us" (revocable at any time by texting NO INTROS), and
  // the per-proposal "yes, introduce us to this one". Neither is a watch consent (that
  // is permission to be TEXTED unprompted) and neither is an autonomous action class
  // (that is permission to ACT on the family's behalf) — this is permission to DISCLOSE
  // the family to a third household, which no other record in this table means.
  'village_intro',
]);

// VIL-147 · what a teen raw-access grant unlocks. Deliberately a CLOSED, SMALL
// vocabulary of CONTENT CLASSES (F14 verdict #8: a grant authorizes a scope + a
// duration, never a blanket read) — every value here has a real ENFORCEMENT site, so
// no scope can be granted that nothing honours. Minting is narrower still: the only
// request surface today is an approval row, which always asks for 'message_content'.
// 'calendar_detail' and 'child_profile' are enforced but not yet requestable. The grant's CHANNEL is always
// the authenticated in-app parent session: no outbound path (email, SMS, push,
// ICS, a third-party MCP read, a public page) ever consults a grant, because a
// grant is a disclosure to ONE parent, not a downgrade of the teen's redaction.
export const teenAccessScopeEnum = pgEnum('teen_access_scope', [
  // The verbatim text of a message or post Hale observed — the privacy page's exact
  // promise. Enforced at the effectiveTeenContent seam (approvals, approvals
  // history, the trail, the messages inbox).
  'message_content',
  // The teen's calendar item titles, times, and places, in-app only.
  'calendar_detail',
  // The teen's profile as read by Hale's assistant tools (the Ask Hale guard).
  'child_profile',
]);

// B18: family-level billing tier. Gates autonomous EXECUTION only — observe/draft
// is free for every stage and child. Values mirror @hale/types PlanTier.
export const planTierEnum = pgEnum('plan_tier', ['free', 'plus', 'family']);

// A child's gender, captured as an OPTIONAL onboarding field (rule #1: sensitive).
// Non-null with an explicit 'unspecified' default so a skipped answer is a value,
// not a SQL null. Values mirror @hale/types ChildGender.
export const childGenderEnum = pgEnum('child_gender', ['boy', 'girl', 'nonbinary', 'unspecified']);

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
  // VIL-245 · M10 — a party the family is HOSTING, declared over messaging. Its own
  // source rather than 'channel' because the two mean different things to the host
  // reply handler: a 'channel' row is any occasion a text mentioned, while a 'party'
  // row is the one thing a "yes, make me a link" may attach a public page to. Sharing
  // the value would let a plain "add Leo's party Sat 2pm" be turned into a shareable
  // page by an unrelated "yes" arriving minutes later.
  'party',
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
export const childNameLevelEnum = pgEnum('child_name_level', ['first_name', 'relation', 'generic']);

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
  // VIL-237 · the conversational SMS intake exchange, in both directions. Its own
  // category (not 'reply') because loop enforcement — quiet hours, caps, per-category
  // prefs — must never apply to it: intake is a live conversation the parent started,
  // and there are no prefs to read until the family exists.
  'intake',
  // VIL-239 · F14's unprompted "Hale noticed something" message. Its own category
  // because the outbound gate's frequency cap COUNTS it: sharing 'reminder' would let
  // a D1 event reminder eat a family's weekly nudge budget, and vice versa.
  'nudge',
  // VIL-241 · the caregiver-invite exchange (parent-side and caregiver-side). Its own
  // category so loop enforcement never applies to it — an invite is a live
  // conversation the parent started — and so a caregiver's ledger is separable from
  // the parents' for a PIPEDA right-to-access read.
  'caregiver',
  // VIL-242 · M7's registration ladder (heads-up, battle plan, go, check-in, waitlist
  // guards). Its own category for the mirror of the reason 'nudge' has one: this class
  // is deliberately UNCAPPED, so sharing 'nudge' would make a family's approved
  // registration legs eat the weekly nudge budget — and then the nudge cap would read
  // as spent by messages it was never meant to govern.
  'registration_sequence',
  // VIL-245 · M10's birthday-party RSVP exchange — the host's share link and tally, and
  // the day-before reminder to a GUEST who asked for one. Its own category for a reason
  // the others do not have: a guest is not a parent and has no users row, so these rows
  // are ledgered against the HOST parent (the M6 caregiver precedent). Folding them into
  // any parent-facing category would make one family's guest volume read as messages
  // Hale sent the PARENT — wrong in a PIPEDA right-to-access read, and wrong in every
  // cap that counts a category.
  'rsvp',
  // Village intros v1 · the three texts the intro loop can send — the discoverability
  // ask, the coarse card, the soft close. Its own category because the outbound gate
  // COUNTS a category: folding these into 'nudge' would spend a family's weekly nudge
  // budget on an intro question and then read the nudge cap as spent by messages the
  // nudge sweep never sent.
  'village_intro',
  // The voice front door · the one text Hale sends because somebody CALLED the number.
  // Its own category because the reason the message exists is not visible anywhere else
  // in the row: a PIPEDA right-to-access read has to be able to say "this text exists
  // because you phoned us", and a support question about a stray SMS is answered by the
  // category alone. It is also the only outbound class whose trigger was a different
  // channel, so no cap and no quiet-hours rule governs it — it is a direct answer to a
  // call the parent is still on.
  'voice',
  // The follow-up ask · Hale checking back after something it set up actually happened
  // — an introduction three days ago, an activity it placed yesterday. Its own category
  // for the reason every class above has one: the gate COUNTS a category, and this class
  // carries the rail that matters most to it (at most one follow-up per family per day).
  // Sharing 'nudge' would spend a family's weekly nudge budget on a check-in, and
  // sharing 'village_intro' would put the ACTIVITY follow-up inside the intro loop's
  // budget, where a placement has no business being counted.
  'followup',
]);

/**
 * VIL-242 · M7 — what a family reported about a registration window they were prepared
 * for. Recorded ONLY from the parent's own reply: Hale never sees the municipal portal,
 * so there is no state here Hale could have observed by itself.
 */
export const registrationOutcomeEnum = pgEnum('registration_outcome', [
  'registered',
  'waitlisted',
  'missed',
]);

/**
 * VIL-245 · M10 — what a guest said about a birthday party, in the guest's own words
 * reduced to the only three answers a headcount can use. 'maybe' is a real answer, not
 * a missing one: a host planning a party needs the difference between "no" and "I don't
 * know yet", and collapsing them would make Hale's tally lie in the direction that
 * costs money (too little cake).
 */
export const rsvpResponseEnum = pgEnum('rsvp_response', ['yes', 'no', 'maybe']);

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

// The lifecycle of a materialized event_reminders row (VIL-223 · D1). 'scheduled' is
// the materialized default; 'sent' once dispatched; 'suppressed' when a don't-send
// rule fired (reason in suppress_reason); 'cancelled' when the event was soft-deleted
// (never fires — the trust invariant); 'stale' when the event moved and this row is
// for the old fire time.
export const reminderStatusEnum = pgEnum('reminder_status', [
  'scheduled',
  'sent',
  'suppressed',
  'cancelled',
  'stale',
]);

/**
 * MEM-10 · the kinds of promise Hale makes to a family in its own words, and the ONLY
 * ones the open-loops ledger admits. Deliberately small and closed: a kind exists here
 * because a surface SAYS it and another surface CLOSES it, so a value with no closing
 * path could only ever accumulate debt nobody can discharge.
 *
 *   first_find        — the intake radar's forward beat to a family it had nothing for
 *                       ("your first weekend find lands in a day or two"). Closed by the
 *                       48h proactive nudge, the sweep that beat is true because of.
 *   registration_plan — the M7 heads-up leg's promise to an opted-in household ("I will
 *                       send your plan the evening before"). Closed by the battle-plan leg.
 */
export const agentCommitmentKindEnum = pgEnum('agent_commitment_kind', [
  'first_find',
  'registration_plan',
]);
