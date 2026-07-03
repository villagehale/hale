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
 * The curated verb → (sentence, family) map. Sentences are Hale's own warm
 * phrasing; none contain the raw token's dots or underscores.
 */
const VERBS: Record<string, Verb> = {
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
};

const NEUTRAL: Verb = { sentence: 'recorded an action', family: 'neutral' };

export function trailVerb(actionTaken: string): Verb {
  return VERBS[actionTaken] ?? NEUTRAL;
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
