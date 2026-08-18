import type { EntryTone } from '~/components/hale/tone';

/**
 * The verb registry. HARD rule (mirrors the label layer): a stored audit verb —
 * memory-writer's `actionTaken` token (`action.executed`, `event.dropped.spend_ceiling`,
 * …) — is NEVER rendered raw on the trail. Every row runs its verb through here,
 * which returns a warm human SENTENCE and a verb FAMILY. An unknown token degrades
 * to a NEUTRAL sentence + the `neutral` family — never the de-dotted token, never a
 * mislabelled tone.
 *
 * Source of truth for the inventory: every `actionTaken` string written anywhere in
 * apps/web, apps/worker and packages. Templated tokens (`action.reviewer.${verdict}`,
 * `action.reviewed.${kind}`, `event.dropped.${reason}`, `action.gated.${reason}`,
 * `event.stage.${stage}`, `quick_log_${type}`, `document_*_${kind}`, …) are
 * enumerated to their concrete values so the map is exhaustive rather than a prefix
 * guess.
 *
 * That inventory is not maintained by hand and hope: verbs-drift.test.ts scans the
 * source for every audit write and fails when one is missing from AUDIT_VERBS. It
 * exists because 93 verbs — the entire SMS/voice/email surface, caregiver invites,
 * connected assistants, the document vault, village introductions, the registration
 * radar, and the executor's own calendar writes — were all silently falling to the
 * NEUTRAL fallback at once: a messaging-first product describing its own work to
 * parents as "recorded an update".
 */

/**
 * The verb families. The family — not the individual verb — drives the row's
 * tone, so a rejection and an execution-failure share the same visual weight
 * without enumerating every token twice.
 *   done     — a settled, successful outcome (executed, approved, recorded)
 *   awaiting — held for a parent's decision (surfaced, gated on consent/window)
 *   note     — a quiet internal checkpoint (classified, drafted, per-stage)
 *   problem  — a failure or a hard block (execution failed, spend ceiling, rejected)
 *   neutral  — an unknown verb; the safe, non-committal fallback
 */
export type VerbFamily = 'done' | 'awaiting' | 'note' | 'problem' | 'neutral';

interface Verb {
  sentence: string;
  family: VerbFamily;
}

/**
 * The canonical inventory of every audit `action_taken` token the app writes —
 * the single source of truth the registry must cover and the trail test
 * enumerates. Derived by expanding the write sites' templated tokens to their
 * concrete values:
 *   - worker memory-writer.ts: classify/draft/review/execute/surface/gate/stage,
 *     `event.dropped.${reason}`, `action.reviewer.${column}`, `action.gated.${reason}`,
 *     `event.stage.${stage}`, village discovery/routine;
 *   - web pipeline record.ts: `event.classified`, `action.drafted`,
 *     `action.reviewed.${kind}`, `event.dropped.spend_ceiling`, `action.gated.${reason}`;
 *   - web household/onboarding/companion/rights/village/coach/plan writes
 *     (`family_created`, `tos_accepted`, `quick_log_${type}`, …).
 * `tool:<name>` sub-steps are excluded upstream (trail-query.ts) and are not
 * parent-facing, so they are intentionally NOT in this inventory. Keeping this
 * list beside the registry — with VERBS typed as Record<AuditVerb, Verb> — makes
 * a missing sentence a COMPILE error, not a runtime raw-token leak.
 */
export const AUDIT_VERBS = [
  // ── worker pipeline (memory-writer.ts) ──────────────────────────────────
  'event.classified',
  'action.drafted',
  'action.drafted_duplicate_suppressed',
  'action.reviewer.approved',
  'action.reviewer.rejected',
  'action.reviewer.flagged',
  'action.executed',
  'action.execution_failed',
  'event.dropped.low_confidence',
  'event.dropped.unknown_action_type',
  'event.dropped.needs_human',
  'event.dropped.spend_ceiling',
  'action.surfaced_to_user',
  'action.entitlement_gated',
  'action.gated.observation_window',
  'action.gated.streak',
  'action.gated.cross_parent_consent',
  'action.gated.teen_redaction',
  'action.gated.over_allowance',
  'action.send_skipped_duplicate',
  'event.stage.classified',
  'event.stage.drafted',
  'event.stage.reviewed',
  'event.stage.approved_pending_execute',
  'event.stage.actioned',
  'event.stage.failed',
  'action.approved_by_human',
  'village.discovery.recorded',
  'village.routine.recorded',
  // ── web draft pipeline (record.ts) ──────────────────────────────────────
  'action.reviewed.approve',
  'action.reviewed.reject',
  'action.reviewed.flag_for_human',
  // ── web household / onboarding ──────────────────────────────────────────
  'family_created',
  'tos_accepted',
  'child_added',
  'child_updated',
  'child_removed',
  'family_location_updated',
  'family_plan_updated',
  'family_plan_comped',
  'family_intents_updated',
  'parent_name_updated',
  'invite_created',
  'invite_accepted',
  // ── web companion quick-log ─────────────────────────────────────────────
  'quick_log_feed',
  'quick_log_nap',
  'quick_log_milestone',
  'quick_log_booking_requested',
  'quick_log_health_done',
  'quick_log_edited',
  'quick_log_deleted',
  // ── web plan ────────────────────────────────────────────────────────────
  'plan_created',
  'plan_completed',
  'plan_deleted',
  // ── web village share / endorse ─────────────────────────────────────────
  'week_plan_shared',
  'village_activity_shared',
  'village_candidate_endorsed',
  'share_link_revoked',
  // ── web rights (PIPEDA) ─────────────────────────────────────────────────
  'data_exported',
  'account_deletion_scheduled',
  // ── web coach (Ask Hale) ────────────────────────────────────────────────
  'ask_hale.action_drafted',
  // The same inline-action spine under its other two origins (inline-action.ts
  // ORIGIN_STAMPS). Both were written but uncurated, so an MCP proposal and a
  // cron-minted registration shortlist both degraded to "recorded an update".
  'mcp.action_drafted',
  'registration_sweep.action_drafted',
  'coach_turn_deleted',
  'coach_conversation_erased',
  // ── web teen access ─────────────────────────────────────────────────────
  'teen_content_access.requested',
  'teen_content_access.teen_notified',
  'teen_content_access.assented',
  'teen_content_access.safety_escalation',
  'teen_content_access.revoked',
  // ── the messaging product itself (SMS / voice / email / push) ───────────
  'channel_sms_enrolled',
  'channel_sms_revoked',
  'sms_reply_received',
  'sms_reply_sent',
  'sms_intake_inbound',
  'sms_intake_outbound',
  'sms_intake_provisioned',
  'voice_call_received',
  'voice_callback_sent',
  'channel_sent',
  'push_sent',
  'email_reply_received',
  'email_unsubscribe_received',
  'parent_email_captured',
  'parent_name_captured',
  'channel_sms.calendar_drafted',
  // ── proactive nudges + the watch offer ──────────────────────────────────
  'proactive_nudge_sent',
  'proactive_nudge_skipped',
  'proactive_watch_granted',
  'proactive_watch_declined',
  // ── caregiver invites ───────────────────────────────────────────────────
  'caregiver_invite_started',
  'caregiver_access_granted',
  'caregiver_invite_accepted',
  'caregiver_invite_expired',
  'caregiver_invite_superseded',
  'caregiver_invite_withdrawn',
  'caregiver_invite_refused',
  'caregiver_sms_inbound',
  'caregiver_sms_outbound',
  // ── the executor's own writes (internal-writes.ts) ──────────────────────
  'action.routine_pinned',
  'action.routine_pinned.skipped_duplicate',
  'action.digest_noted',
  'action.digest_noted.skipped_duplicate',
  'action.calendar_placed',
  'action.calendar_placed.skipped_duplicate',
  'action.calendar_moved',
  'action.calendar_moved.skipped_duplicate',
  'action.calendar_cancelled',
  'action.calendar_cancelled.skipped_duplicate',
  // ── decline + undo ──────────────────────────────────────────────────────
  'action.declined_by_human',
  'action.calendar_placement_reverted',
  'action.reverted_by_human',
  // The sixth ActionGateReason; the other five were curated, this one was not.
  'action.gated.autonomy_not_opted_in',
  // ── the weekly loop + calendar subscription ─────────────────────────────
  'compose_week_plan',
  'week_plan.calendar_drafted',
  'ics_feed_shared',
  'ics_feed_revoked',
  'notification_pref_updated',
  // ── connected assistants (MCP) ──────────────────────────────────────────
  'mcp.authorization_approved',
  'mcp.grant_issued',
  'mcp.grant_revoked',
  'mcp.tool_called',
  // ── files: chat attachments + the document vault ────────────────────────
  'chat_attachment_uploaded',
  'chat_attachment_swept',
  'chat_attachment_view_url',
  'document_uploaded_health',
  'document_uploaded_insurance',
  'document_uploaded_other',
  'document_view_url_health',
  'document_view_url_insurance',
  'document_view_url_other',
  'document_deleted_health',
  'document_deleted_insurance',
  'document_deleted_other',
  // ── children + companion ────────────────────────────────────────────────
  'child_avatar_set',
  'child_avatar_removed',
  'quick_log_diaper',
  'quick_log_measurement',
  'health_checkpoint_marked_done',
  // ── connectors, settings, billing ───────────────────────────────────────
  'integration_connected',
  'integration_revoked',
  'user_preferences_updated',
  'billing_checkout_started',
  // ── parties ─────────────────────────────────────────────────────────────
  'party_invite_created',
  'party_invite_cancelled',
  'party_rsvp_submitted',
  'party_guest_message_sent',
  // ── the registration radar ──────────────────────────────────────────────
  'registration_shortlist_drafted',
  'registration_sequence_leg_sent',
  'registration_outcome_recorded',
  // ── village areas, saves, civic sweep ───────────────────────────────────
  'village_area_added',
  'village_area_activated',
  'village_area_removed',
  'village_candidate_saved',
  'village_candidate_unsaved',
  'civic.candidates.projected',
  // ── village introductions (cross-household — rule #1) ───────────────────
  'village_intro_discoverability_granted',
  'village_intro_discoverability_revoked',
  'village_intro_ask_sent',
  'village_intro_proposed',
  'coach_plan_message_sent',
  'coach_plan_check_in_sent',
  'village_intro_card_sent',
  'village_intro_accepted',
  'village_intro_declined',
  'village_intro_identity_asked',
  'village_intro_disclosed',
  'village_intro_closed',
  // ── claiming the receipts room, and Hale asking how it went ─────────────
  'account_claimed_by_phone',
  'followup_intro_asked',
  'followup_activity_asked',
  'smoke_alarm_fired',
] as const;

export type AuditVerb = (typeof AUDIT_VERBS)[number];

/**
 * The curated verb → (sentence, family) map. Sentences are Hale's own warm
 * phrasing; none contain the raw token's dots or underscores. Typed
 * `Record<AuditVerb, Verb>` so a verb in the inventory with no sentence is a
 * COMPILE error — the registry can never fall behind the tokens the app writes.
 */
const VERBS: Record<AuditVerb, Verb> = {
  'event.classified': { sentence: 'understood a new signal', family: 'note' },
  'action.drafted': { sentence: 'drafted an action for you', family: 'note' },
  'action.drafted_duplicate_suppressed': {
    sentence: 'skipped a duplicate draft',
    family: 'note',
  },
  'action.reviewer.approved': { sentence: 'the reviewer verified it', family: 'done' },
  'action.reviewer.rejected': {
    sentence: 'the reviewer raised a concern and held it',
    family: 'problem',
  },
  'action.reviewer.flagged': { sentence: 'the reviewer flagged it for you', family: 'awaiting' },
  'action.reviewed.approve': { sentence: 'the reviewer verified it', family: 'done' },
  'action.reviewed.reject': {
    sentence: 'the reviewer raised a concern and held it',
    family: 'problem',
  },
  'action.reviewed.flag_for_human': {
    sentence: 'the reviewer flagged it for you',
    family: 'awaiting',
  },
  'action.executed': { sentence: 'carried out the action', family: 'done' },
  'action.execution_failed': { sentence: 'an action could not be completed', family: 'problem' },
  'event.dropped.low_confidence': {
    sentence: 'set a low-confidence signal aside',
    family: 'note',
  },
  'event.dropped.unknown_action_type': {
    sentence: 'set aside a signal it could not act on',
    family: 'note',
  },
  'event.dropped.needs_human': { sentence: 'routed a signal to you', family: 'awaiting' },
  'event.dropped.spend_ceiling': {
    sentence: 'stopped at your spending cap',
    family: 'problem',
  },
  'action.surfaced_to_user': { sentence: 'brought a draft to you', family: 'awaiting' },
  'action.entitlement_gated': {
    sentence: 'held an action for your plan',
    family: 'awaiting',
  },
  'action.gated.observation_window': {
    sentence: 'held back during your first-week observation window',
    family: 'awaiting',
  },
  'action.gated.streak': {
    sentence: 'held for your approval — still earning your trust',
    family: 'awaiting',
  },
  'action.gated.cross_parent_consent': {
    sentence: 'held for your co-parent to sign on',
    family: 'awaiting',
  },
  'action.gated.teen_redaction': {
    sentence: 'held to protect your teenager’s privacy',
    family: 'awaiting',
  },
  'action.gated.over_allowance': {
    sentence: 'held — past your plan’s allowance',
    family: 'awaiting',
  },
  'action.send_skipped_duplicate': { sentence: 'skipped a duplicate send', family: 'note' },
  'event.stage.classified': { sentence: 'moved a signal to classified', family: 'note' },
  'event.stage.drafted': { sentence: 'moved a signal to drafted', family: 'note' },
  'event.stage.reviewed': { sentence: 'moved a signal to reviewed', family: 'note' },
  'event.stage.approved_pending_execute': {
    sentence: 'approved and queued a signal to act on',
    family: 'note',
  },
  'event.stage.actioned': { sentence: 'finished acting on a signal', family: 'done' },
  'event.stage.failed': { sentence: 'a signal could not be finished', family: 'problem' },
  'action.approved_by_human': { sentence: 'you approved the action', family: 'done' },
  'village.discovery.recorded': { sentence: 'found a village activity', family: 'done' },
  'village.routine.recorded': { sentence: 'pinned an activity to your routine', family: 'done' },
  plan_created: { sentence: 'you added a plan', family: 'done' },
  plan_completed: { sentence: 'you finished a plan', family: 'done' },
  plan_deleted: { sentence: 'you removed a plan', family: 'done' },
  data_exported: { sentence: 'you exported a copy of your data', family: 'done' },
  account_deletion_scheduled: {
    sentence: 'you scheduled your account for deletion',
    family: 'awaiting',
  },
  share_link_revoked: { sentence: 'you turned off a shared link', family: 'done' },
  coach_turn_deleted: { sentence: 'you removed a message from Hale', family: 'done' },
  coach_conversation_erased: { sentence: 'you erased your Hale conversation', family: 'done' },
  'ask_hale.action_drafted': { sentence: 'Hale drafted an action for you', family: 'note' },
  'mcp.action_drafted': {
    sentence: 'your assistant proposed an action and Hale held it for you',
    family: 'awaiting',
  },
  'registration_sweep.action_drafted': {
    sentence: 'Hale found a registration window and drafted a shortlist for you',
    family: 'note',
  },
  // ── household / onboarding ──────────────────────────────────────────────
  family_created: { sentence: 'you set up your family', family: 'done' },
  tos_accepted: { sentence: 'you accepted the terms', family: 'done' },
  child_added: { sentence: 'you added a child', family: 'done' },
  child_updated: { sentence: 'you updated a child’s details', family: 'done' },
  child_removed: { sentence: 'you removed a child', family: 'done' },
  family_location_updated: { sentence: 'you updated your family’s location', family: 'done' },
  family_plan_updated: { sentence: 'you changed your plan', family: 'done' },
  family_plan_comped: { sentence: 'your family got the Family plan, free for life', family: 'done' },
  family_intents_updated: { sentence: 'you updated what you’d like help with', family: 'done' },
  parent_name_updated: { sentence: 'you updated your name', family: 'done' },
  invite_created: { sentence: 'you invited your co-parent', family: 'done' },
  invite_accepted: { sentence: 'a co-parent joined your family', family: 'done' },
  // ── companion quick-log ─────────────────────────────────────────────────
  quick_log_feed: { sentence: 'you logged a feed', family: 'done' },
  quick_log_nap: { sentence: 'you logged a nap', family: 'done' },
  quick_log_milestone: { sentence: 'you logged a milestone', family: 'done' },
  quick_log_booking_requested: { sentence: 'you noted a booking to make', family: 'done' },
  quick_log_health_done: { sentence: 'you marked a health item done', family: 'done' },
  quick_log_edited: { sentence: 'you edited a logged moment', family: 'done' },
  quick_log_deleted: { sentence: 'you removed a logged moment', family: 'done' },
  // ── village share / endorse ─────────────────────────────────────────────
  week_plan_shared: { sentence: 'you shared your week plan', family: 'done' },
  village_activity_shared: { sentence: 'you shared a village activity', family: 'done' },
  village_candidate_endorsed: { sentence: 'you endorsed a village suggestion', family: 'done' },
  // ── teen access (rule #1) ───────────────────────────────────────────────
  'teen_content_access.requested': {
    sentence: 'you asked to see your teenager’s content',
    family: 'awaiting',
  },
  'teen_content_access.teen_notified': {
    sentence: 'Hale went to tell your teenager about that request',
    family: 'awaiting',
  },
  'teen_content_access.assented': {
    sentence: 'your teenager agreed to share that content with you',
    family: 'done',
  },
  // Deliberately the plainest, least euphemistic sentence in this file: this is the
  // one row that means a teen's content was opened WITHOUT their agreement.
  'teen_content_access.safety_escalation': {
    sentence: 'you opened your teenager’s content for safety, without their agreement',
    // 'problem' rather than 'done': this row is not an accomplishment, and the trail
    // should not colour it like one. It is the most consequential line Hale can write
    // about a family, and it should read that way at a glance.
    family: 'problem',
  },
  'teen_content_access.revoked': {
    sentence: 'access to your teenager’s content was closed',
    family: 'done',
  },
  // ── the messaging product itself ────────────────────────────────────────
  // Hale lives in SMS; these are the most common rows a real family will have.
  // They were the whole reason the trail read as "Hale recorded an update".
  channel_sms_enrolled: { sentence: 'your phone was set up to text with Hale', family: 'done' },
  channel_sms_revoked: { sentence: 'you turned off texting with Hale', family: 'done' },
  sms_reply_received: { sentence: 'you texted Hale', family: 'note' },
  sms_reply_sent: { sentence: 'Hale texted you back', family: 'note' },
  sms_intake_inbound: { sentence: 'you texted Hale while getting set up', family: 'note' },
  sms_intake_outbound: { sentence: 'Hale texted you while getting set up', family: 'note' },
  sms_intake_provisioned: { sentence: 'your family was set up from your texts', family: 'done' },
  voice_call_received: {
    // Hale keeps no audio and no transcript — only that a call arrived.
    sentence: 'a call came in to Hale’s number',
    family: 'note',
  },
  voice_callback_sent: { sentence: 'Hale texted you back after your call', family: 'note' },
  channel_sent: { sentence: 'Hale sent you a message', family: 'done' },
  push_sent: { sentence: 'Hale sent you a notification', family: 'done' },
  email_reply_received: { sentence: 'you replied to one of Hale’s emails', family: 'note' },
  // VIL-249: the parent texted an address back, and Hale saved it as the one it
  // emails calendar invites to. 'done' because it is a write to their account, not
  // a message — the trail should show it beside the other things that changed.
  parent_email_captured: {
    sentence: 'you gave Hale an email address for calendar invites',
    family: 'done',
  },
  // The parent texted back what to call them. 'done' for the same reason the address
  // is: it is a write to their account rather than a message, so the trail should show
  // it beside the other things that changed.
  parent_name_captured: { sentence: 'you told Hale what to call you', family: 'done' },
  email_unsubscribe_received: { sentence: 'you unsubscribed from an email', family: 'done' },
  'channel_sms.calendar_drafted': {
    sentence: 'your text became a calendar change, waiting on your yes',
    family: 'awaiting',
  },
  // ── proactive nudges + the watch offer ──────────────────────────────────
  proactive_nudge_sent: { sentence: 'Hale texted you something worth knowing', family: 'done' },
  proactive_nudge_skipped: {
    // The quiet-operator promise, made visible: a deliberate silence is a real
    // outcome, and a parent should be able to see Hale choosing not to interrupt.
    sentence: 'Hale had nothing worth interrupting you for',
    family: 'note',
  },
  proactive_watch_granted: { sentence: 'you let Hale watch for things to flag', family: 'done' },
  proactive_watch_declined: {
    sentence: 'you asked Hale not to watch for things to flag',
    family: 'done',
  },
  // ── caregiver invites ───────────────────────────────────────────────────
  caregiver_invite_started: { sentence: 'you asked Hale to invite a caregiver', family: 'note' },
  caregiver_access_granted: {
    sentence: 'you confirmed what a caregiver may see',
    family: 'done',
  },
  caregiver_invite_accepted: {
    sentence: 'a caregiver accepted and joined your family',
    family: 'done',
  },
  caregiver_invite_expired: {
    sentence: 'a caregiver invite expired unanswered',
    family: 'note',
  },
  caregiver_invite_superseded: {
    sentence: 'you replaced an earlier caregiver invite',
    family: 'note',
  },
  caregiver_invite_withdrawn: { sentence: 'you withdrew a caregiver invite', family: 'done' },
  caregiver_invite_refused: { sentence: 'a caregiver declined your invite', family: 'note' },
  caregiver_sms_inbound: { sentence: 'a caregiver texted Hale', family: 'note' },
  caregiver_sms_outbound: { sentence: 'Hale texted a caregiver', family: 'note' },
  // ── what the executor actually did ──────────────────────────────────────
  'action.routine_pinned': { sentence: 'pinned an activity to your week', family: 'done' },
  'action.routine_pinned.skipped_duplicate': {
    sentence: 'skipped pinning something already on your week',
    family: 'note',
  },
  // Deliberately not "added to your digest": that daily digest no longer exists.
  // What the write really does is keep an undated note.
  'action.digest_noted': { sentence: 'kept a note about something, undated', family: 'note' },
  'action.digest_noted.skipped_duplicate': {
    sentence: 'skipped a note it had already made',
    family: 'note',
  },
  'action.calendar_placed': { sentence: 'put something on your calendar', family: 'done' },
  'action.calendar_placed.skipped_duplicate': {
    sentence: 'skipped a calendar entry it had already made',
    family: 'note',
  },
  'action.calendar_moved': { sentence: 'moved something on your calendar', family: 'done' },
  'action.calendar_moved.skipped_duplicate': {
    sentence: 'skipped a calendar change it had already made',
    family: 'note',
  },
  'action.calendar_cancelled': { sentence: 'took something off your calendar', family: 'done' },
  'action.calendar_cancelled.skipped_duplicate': {
    sentence: 'skipped a cancellation it had already made',
    family: 'note',
  },
  // ── decline + undo ──────────────────────────────────────────────────────
  'action.declined_by_human': { sentence: 'you dismissed a draft', family: 'done' },
  'action.calendar_placement_reverted': {
    sentence: 'you undid a calendar entry Hale had made',
    family: 'done',
  },
  'action.reverted_by_human': { sentence: 'you reversed a completed action', family: 'done' },
  'action.gated.autonomy_not_opted_in': {
    sentence: 'held for your approval — you haven’t let Hale do this on its own',
    family: 'awaiting',
  },
  // ── the weekly loop + calendar subscription ─────────────────────────────
  compose_week_plan: { sentence: 'put together your week', family: 'done' },
  'week_plan.calendar_drafted': {
    sentence: 'drafted a calendar entry from your week, waiting on your yes',
    family: 'awaiting',
  },
  ics_feed_shared: { sentence: 'you turned on your calendar subscription', family: 'done' },
  ics_feed_revoked: { sentence: 'you turned off your calendar subscription', family: 'done' },
  notification_pref_updated: { sentence: 'you changed how Hale reaches you', family: 'done' },
  // ── connected assistants (MCP) ──────────────────────────────────────────
  // An MCP client is a THIRD PARTY reading family data. These sentences name that
  // plainly rather than calling it an integration (rule #1).
  'mcp.authorization_approved': {
    sentence: 'you approved an outside assistant’s request to connect',
    family: 'done',
  },
  'mcp.grant_issued': {
    sentence: 'an outside assistant was connected to your family’s data',
    family: 'done',
  },
  'mcp.grant_revoked': { sentence: 'you disconnected an outside assistant', family: 'done' },
  'mcp.tool_called': {
    // The outcome (allowed / denied / rate-limited) lives in the row's detail, so the
    // sentence says a request was MADE rather than claiming data was handed over.
    sentence: 'a connected assistant made a request for your family’s data',
    family: 'note',
  },
  // ── files: chat attachments + the document vault ────────────────────────
  chat_attachment_uploaded: {
    sentence: 'you added a file to a conversation with Hale',
    family: 'done',
  },
  chat_attachment_swept: { sentence: 'cleared away a file that was never sent', family: 'note' },
  chat_attachment_view_url: { sentence: 'a file you uploaded was opened', family: 'note' },
  document_uploaded_health: { sentence: 'you added a health document', family: 'done' },
  document_uploaded_insurance: { sentence: 'you added an insurance document', family: 'done' },
  document_uploaded_other: { sentence: 'you added a document', family: 'done' },
  document_view_url_health: { sentence: 'a health document was opened', family: 'note' },
  document_view_url_insurance: { sentence: 'an insurance document was opened', family: 'note' },
  document_view_url_other: { sentence: 'a document was opened', family: 'note' },
  document_deleted_health: { sentence: 'you removed a health document', family: 'done' },
  document_deleted_insurance: { sentence: 'you removed an insurance document', family: 'done' },
  document_deleted_other: { sentence: 'you removed a document', family: 'done' },
  // ── children + companion ────────────────────────────────────────────────
  child_avatar_set: { sentence: 'you set a photo for a child', family: 'done' },
  child_avatar_removed: { sentence: 'you removed a child’s photo', family: 'done' },
  quick_log_diaper: { sentence: 'you logged a diaper change', family: 'done' },
  quick_log_measurement: { sentence: 'you logged a measurement', family: 'done' },
  health_checkpoint_marked_done: {
    sentence: 'you confirmed a health checkpoint is done',
    family: 'done',
  },
  // ── connectors, settings, billing ───────────────────────────────────────
  integration_connected: { sentence: 'you connected an account to Hale', family: 'done' },
  integration_revoked: { sentence: 'you disconnected an account', family: 'done' },
  user_preferences_updated: { sentence: 'you updated your preferences', family: 'done' },
  // Started, not finished: the row is written before checkout completes.
  billing_checkout_started: { sentence: 'you started an upgrade', family: 'note' },
  // ── parties ─────────────────────────────────────────────────────────────
  party_invite_created: { sentence: 'you made a party invite link', family: 'done' },
  party_invite_cancelled: { sentence: 'you cancelled a party invite', family: 'done' },
  party_rsvp_submitted: { sentence: 'a guest replied to your party invite', family: 'done' },
  party_guest_message_sent: { sentence: 'Hale texted a party guest', family: 'note' },
  // ── the registration radar ──────────────────────────────────────────────
  registration_shortlist_drafted: {
    sentence: 'Hale put together a registration shortlist',
    family: 'note',
  },
  registration_sequence_leg_sent: {
    sentence: 'Hale nudged you about a registration window',
    family: 'done',
  },
  registration_outcome_recorded: {
    sentence: 'you told Hale how a registration went',
    family: 'done',
  },
  // ── village areas, saves, civic sweep ───────────────────────────────────
  village_area_added: { sentence: 'you added a place for Hale to look in', family: 'done' },
  village_area_activated: { sentence: 'you changed where Hale looks', family: 'done' },
  village_area_removed: { sentence: 'you removed a place Hale was looking in', family: 'done' },
  village_candidate_saved: { sentence: 'you saved a village suggestion', family: 'done' },
  village_candidate_unsaved: { sentence: 'you removed a saved suggestion', family: 'done' },
  'civic.candidates.projected': {
    sentence: 'found activities in your city’s listings',
    family: 'note',
  },
  // ── village introductions (cross-household — rule #1) ───────────────────
  village_intro_discoverability_granted: {
    sentence: 'you let Hale introduce your family to others',
    family: 'done',
  },
  village_intro_discoverability_revoked: {
    sentence: 'you turned off introductions to other families',
    family: 'done',
  },
  village_intro_ask_sent: {
    sentence: 'Hale asked whether you’d like introductions',
    family: 'note',
  },
  village_intro_proposed: {
    sentence: 'Hale found another family to introduce you to',
    family: 'note',
  },
  // One row per message of a plan, so the trail shows what actually reached the phone
  // rather than "a plan was sent" over three texts that may not all have landed. The
  // sentence has to say MESSAGE for the same reason: a plan is 2-3 texts (compose.ts),
  // and "Hale sent you a coaching plan" three times over reads as three plans.
  coach_plan_message_sent: { sentence: 'Hale texted you part of a coaching plan', family: 'note' },
  coach_plan_check_in_sent: {
    sentence: 'Hale checked in on your plan',
    family: 'note',
  },
  village_intro_card_sent: { sentence: 'Hale asked you about an introduction', family: 'awaiting' },
  village_intro_accepted: { sentence: 'you said yes to an introduction', family: 'done' },
  village_intro_declined: { sentence: 'you said no to an introduction', family: 'done' },
  // Both sides said yes and Hale was short a detail about YOU — nothing about the other
  // family, and nothing shared. 'awaiting' because the introduction is still owed.
  village_intro_identity_asked: {
    sentence: 'Hale asked you for a detail it needed to make an introduction',
    family: 'awaiting',
  },
  village_intro_disclosed: {
    // The one row here that means information actually crossed households. Like the
    // teen safety line above, it says so outright rather than "completed an intro".
    sentence: 'both families said yes, so your contact details were shared',
    family: 'done',
  },
  village_intro_closed: { sentence: 'an introduction was closed', family: 'note' },
  // ── claiming the receipts room, and Hale asking how it went ─────────────
  account_claimed_by_phone: {
    sentence: 'you signed in with a code texted to your phone',
    family: 'done',
  },
  followup_intro_asked: { sentence: 'Hale asked how your introduction went', family: 'note' },
  followup_activity_asked: {
    sentence: 'Hale asked how something on your calendar went',
    family: 'note',
  },
  smoke_alarm_fired: {
    // Something urgent arrived while Hale could not reach its model, so a fixed
    // safety line went out instead of an answer. 'problem', not 'done': the parent
    // was texted, but they were not actually helped, and the trail should say so.
    sentence: 'Hale could not reach its model, so it sent you a fixed safety message',
    family: 'problem',
  },
};

const NEUTRAL: Verb = { sentence: 'recorded an update', family: 'neutral' };

/**
 * The stored verb → its warm sentence + family. A token in the inventory hits the
 * registry; anything else (a future write site not yet curated) degrades to the
 * NEUTRAL sentence — a fixed human phrase that never echoes the raw token, so the
 * trail can never render a snake_case/dotted internal string.
 */
export function trailVerb(actionTaken: string): Verb {
  return VERBS[actionTaken as AuditVerb] ?? NEUTRAL;
}

/**
 * The verb family → row tone. Failures/blocks read `needs-you` (never `done`);
 * held-for-you reads `awaiting`; quiet checkpoints and the neutral fallback read
 * `coach` (a quiet note). Only genuinely settled outcomes read `done`.
 */
const FAMILY_TONE: Record<VerbFamily, EntryTone> = {
  done: 'done',
  awaiting: 'awaiting',
  note: 'coach',
  problem: 'needs-you',
  neutral: 'coach',
};

export function verbTone(family: VerbFamily): EntryTone {
  return FAMILY_TONE[family];
}

/**
 * A stored `target_table` → the domain noun a parent understands. Never the raw
 * table name; an unknown/absent table degrades to `record`.
 */
const TARGET_NOUNS: Record<string, string> = {
  actions: 'draft',
  events: 'signal',
  family_plans: 'plan',
  families: 'family settings',
  children: 'child',
  family_members: 'household',
  family_invites: 'invite',
  family_memory_episodes: 'logged moment',
  village_candidates: 'village suggestion',
  routine_proposals: 'routine',
  consent_records: 'consent',
  teen_access_grants: 'teen privacy request',
  conversations: 'Hale',
  messages: 'Hale',
  users: 'your profile',
};

export function targetNoun(targetTable: string | null): string {
  if (targetTable === null) return 'record';
  return TARGET_NOUNS[targetTable] ?? 'record';
}

/**
 * A stored (`target_table`, `target_id`) → a deep link to the surface where the
 * parent can actually SEE that record — never a bare UUID. Only tables with a
 * real viewable surface link (actions → the approvals queue, plans → the plan
 * page); everything else returns null so the row shows its noun without a
 * dead/fake link.
 */
const TARGET_ROUTES: Record<string, string> = {
  actions: '/approvals',
  family_plans: '/plan',
};

export function targetLink(targetTable: string | null, targetId: string | null): string | null {
  if (targetTable === null || targetId === null) return null;
  return TARGET_ROUTES[targetTable] ?? null;
}
