import type { ActionType } from '@hale/types';

/**
 * Inline gated actions — the Hale thesis. When an Ask Hale answer IMPLIES a real
 * action, the UI offers a chip that routes through the EXISTING approval engine
 * (draft held for approval, never auto-executed — rule #4) and writes an audit row
 * (rule #6). This module is the small, closed detector: it maps an answer to at
 * most a handful of action intents, each tied to a known ActionType the draft
 * pipeline already knows how to handle. Pure, no I/O.
 *
 * Deliberately minimal: a keyword match, not an LLM call. A miss just means no
 * chip — the parent can still ask directly. A false positive only ever produces a
 * DRAFT a parent must approve, so the cost of a loose match is bounded by rule #4.
 */

export type ActionIntentKind = 'find_activities' | 'add_to_plan' | 'book_checkup' | 'set_reminder';

export interface ActionIntent {
  kind: ActionIntentKind;
  /** The chip's action verb+object label (DESIGN copy rule). */
  label: string;
  /** The known action type the approval engine drafts for this intent. */
  actionType: ActionType;
}

interface IntentRule {
  kind: ActionIntentKind;
  label: string;
  actionType: ActionType;
  patterns: readonly RegExp[];
}

const INTENT_RULES: readonly IntentRule[] = [
  {
    kind: 'find_activities',
    label: 'Find activities',
    actionType: 'add_to_digest_only',
    patterns: [/\bfind activities\b/i, /\b(?:classes|groups|activities)\s+near\s+you\b/i],
  },
  {
    kind: 'add_to_plan',
    label: 'Add to week plan',
    actionType: 'add_to_routine',
    patterns: [/\b(?:add (?:this|it) to|pin to)\s+(?:your )?(?:week ?plan|routine)\b/i],
  },
  {
    kind: 'book_checkup',
    label: 'Book a check-up',
    actionType: 'create_calendar_event',
    patterns: [/\bbook(?:ing)?\s+a\s+(?:check[- ]?up|appointment|visit)\b/i],
  },
  {
    kind: 'set_reminder',
    label: 'Set a reminder',
    actionType: 'create_calendar_event',
    patterns: [/\b(?:set|add)\s+a\s+reminder\b/i, /\bremind you\b/i],
  },
];

/**
 * Detect the action intents an answer implies, deduped by kind (each intent
 * surfaces at most one chip per answer). Returns [] when nothing matches — the
 * common case for an ordinary answer, where no action chip should appear.
 */
export function detectActionIntents(answer: string): ActionIntent[] {
  return INTENT_RULES.filter((rule) => rule.patterns.some((p) => p.test(answer))).map((rule) => ({
    kind: rule.kind,
    label: rule.label,
    actionType: rule.actionType,
  }));
}

const KIND_BY_VALUE = new Map<string, IntentRule>(INTENT_RULES.map((r) => [r.kind, r]));

/** Look up the ActionType for an intent kind — the server's trust boundary so a
 * client can't ask the approval engine to draft an arbitrary action type. */
export function actionTypeForIntent(kind: string): ActionType | null {
  return KIND_BY_VALUE.get(kind)?.actionType ?? null;
}
