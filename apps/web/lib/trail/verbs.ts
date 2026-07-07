import type { EntryTone } from '~/components/hale/tone';

/**
 * The verb registry. HARD rule (mirrors the label layer): a stored audit verb —
 * memory-writer's `actionTaken` token (`action.executed`, `event.dropped.spend_ceiling`,
 * …) — is NEVER rendered raw on the trail. Every row runs its verb through here,
 * which returns a warm human SENTENCE and a verb FAMILY. An unknown token degrades
 * to a NEUTRAL sentence + the `neutral` family — never the de-dotted token, never a
 * mislabelled tone.
 *
 * Source of truth for the inventory: the `actionTaken` strings written across
 * apps/worker/src/services/memory-writer.ts (classify → drop, draft, review,
 * execute, surface, entitlement/autonomy gates, village recorders, per-stage
 * checkpoints), the web draft pipeline's apps/web/lib/pipeline/record.ts (which
 * writes the reviewer verdict as `action.reviewed.${verdict.kind}` — a distinct
 * token shape from the worker's `action.reviewer.${column}`), plus
 * apps/web/lib/plan/plan-core.ts (`plan_created`). Templated tokens
 * (`action.reviewer.${verdict}`, `action.reviewed.${kind}`,
 * `event.dropped.${reason}`, `action.gated.${reason}`, `event.stage.${stage}`)
 * are enumerated to their concrete values so the map is exhaustive rather than a
 * prefix guess.
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
  'coach_turn_deleted',
  'coach_conversation_erased',
  // ── web teen access ─────────────────────────────────────────────────────
  'teen_content_access.requested',
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
  coach_turn_deleted: { sentence: 'you removed a message from Concierge', family: 'done' },
  coach_conversation_erased: { sentence: 'you erased your Concierge conversation', family: 'done' },
  'ask_hale.action_drafted': { sentence: 'Concierge drafted an action for you', family: 'note' },
  // ── household / onboarding ──────────────────────────────────────────────
  family_created: { sentence: 'you set up your family', family: 'done' },
  tos_accepted: { sentence: 'you accepted the terms', family: 'done' },
  child_added: { sentence: 'you added a child', family: 'done' },
  child_updated: { sentence: 'you updated a child’s details', family: 'done' },
  child_removed: { sentence: 'you removed a child', family: 'done' },
  family_location_updated: { sentence: 'you updated your family’s location', family: 'done' },
  family_plan_updated: { sentence: 'you changed your plan', family: 'done' },
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
  conversations: 'Concierge',
  messages: 'Concierge',
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
