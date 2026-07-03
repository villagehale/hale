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

/**
 * INPUT SIDE — the parent's INSTRUCTION, not Hale's answer. When a parent types a
 * command ("book a check-up for Mira", "Noah had a bottle at 3pm") the composer
 * can surface a rich confirm widget before the round-trip. Same discipline as
 * detectActionIntents: a closed set of regex rules, pure, no LLM on the hot path
 * (rule #2 untouched). A miss just means no widget; a false positive only ever
 * shows a confirm the parent can dismiss — bounded cost.
 *
 * Two categories, because they route differently:
 *  - 'action' (book/remind/find): reuses a Hale-acts kind + its ActionType, routes
 *    through the EXISTING approval engine (held for approval — rule #4).
 *  - 'log' (quick_log): the parent's OWN household data — no approval gate. Carries
 *    a best-effort parsed sub-shape the widget pre-fills and the parent can edit.
 */

export type QuickLogEpisode = 'feed' | 'nap' | 'milestone';

export interface QuickLogParse {
  episode: QuickLogEpisode;
  /** A raw time phrase lifted from the text ("3pm", "this afternoon"), or undefined. */
  timeHint?: string;
  /** A capitalised name that reads as the child, or undefined (parent picks). */
  childName?: string;
  /** The milestone text, present only for episode === 'milestone'. */
  milestone?: string;
}

export type InputIntent =
  | { category: 'action'; kind: ActionIntentKind; label: string; actionType: ActionType }
  | { category: 'log'; kind: 'quick_log'; label: string; parsed: QuickLogParse };

/** Imperative phrasings that map an instruction to a Hale-acts kind. Distinct from
 * INTENT_RULES (which read Hale's SUGGESTION copy): here the parent is commanding. */
const INPUT_ACTION_RULES: readonly IntentRule[] = [
  {
    kind: 'book_checkup',
    label: 'Book a check-up',
    actionType: 'create_calendar_event',
    patterns: [/\bbook(?:ing)?\s+(?:a|an|the)?\s*(?:check[- ]?up|appointment|visit|doctor)\b/i],
  },
  {
    kind: 'set_reminder',
    label: 'Set a reminder',
    actionType: 'create_calendar_event',
    patterns: [/\b(?:set|add)\s+a\s+reminder\b/i, /\bremind\s+me\b/i],
  },
  {
    kind: 'find_activities',
    label: 'Find activities',
    actionType: 'add_to_digest_only',
    patterns: [/\bfind\s+(?:some\s+)?(?:activities|classes|groups)\b/i],
  },
];

/** episode → the phrasings that name a logged observation, imperative or reported. */
const QUICK_LOG_EPISODE_RULES: readonly { episode: QuickLogEpisode; patterns: readonly RegExp[] }[] =
  [
    {
      episode: 'feed',
      patterns: [/\b(?:had|took|gave|log(?:ged)?)\s+(?:a\s+)?(?:feed|bottle|nurse|nursing)\b/i],
    },
    {
      episode: 'nap',
      patterns: [/\b(?:had|took|went\s+down\s+for|log(?:ged)?)\s+(?:a\s+)?nap\b/i, /\bnapped\b/i],
    },
    {
      episode: 'milestone',
      patterns: [/\bhit\s+a\s+milestone\b/i, /\b(?:reached|log(?:ged)?)\s+(?:a\s+)?milestone\b/i],
    },
  ];

/** A leading "<Name> had/took/hit …" — a capitalised token that reads as the child. */
const CHILD_NAME_RE = /^\s*([A-Z][a-z]+)\b/;
/** A clock or coarse time phrase to pre-fill "when". Best-effort — the parent edits. */
const TIME_HINT_RE =
  /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b|\b(this (?:morning|afternoon|evening)|last night|tonight|earlier today|yesterday)\b/i;
/** The text after "milestone:" — what the child did. */
const MILESTONE_TEXT_RE = /milestone:\s*(.+)$/i;

function parseQuickLog(question: string, episode: QuickLogEpisode): QuickLogParse {
  const time = question.match(TIME_HINT_RE);
  const name = question.match(CHILD_NAME_RE);
  const parsed: QuickLogParse = { episode };
  if (time) parsed.timeHint = (time[1] ?? time[2])?.trim();
  if (name) parsed.childName = name[1];
  if (episode === 'milestone') {
    const m = question.match(MILESTONE_TEXT_RE);
    if (m?.[1]) parsed.milestone = m[1].trim();
  }
  return parsed;
}

/**
 * Detect the command intents a parent's QUESTION implies, deduped by kind. Returns
 * [] for an ordinary question (the common case). At most one quick_log per send
 * (the first matching episode wins).
 */
export function detectInputIntents(question: string): InputIntent[] {
  const intents: InputIntent[] = [];

  for (const rule of INPUT_ACTION_RULES) {
    if (rule.patterns.some((p) => p.test(question))) {
      intents.push({
        category: 'action',
        kind: rule.kind,
        label: rule.label,
        actionType: rule.actionType,
      });
    }
  }

  const episode = QUICK_LOG_EPISODE_RULES.find((r) => r.patterns.some((p) => p.test(question)));
  if (episode) {
    intents.push({
      category: 'log',
      kind: 'quick_log',
      label: 'Log this',
      parsed: parseQuickLog(question, episode.episode),
    });
  }

  return intents;
}
