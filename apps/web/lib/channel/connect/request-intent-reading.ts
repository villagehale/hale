import type { ReplyLanguage } from '../language';

/**
 * VIL-413 / VIL-417 · what a parent's message ASKS FOR, as the model reads it, and the
 * guards code keeps on that reading.
 *
 * Until this change two regexes decided it: `matchConnectorRequest` (a connect verb, a
 * lead, a provider noun, a negation class, a status-auxiliary class) and
 * `matchBothFreeAsk` (five fixed phrasings). Founder rule, 2026-10-04: intent is inferred
 * by the model, not by keyword branches. So the model says whether the message asks to
 * connect an account or for a shared-free window; code acts on the label and never on a
 * word.
 *
 * Pure, relative imports only: the worker eval loads this module through tsx and settles
 * the real model's answers through the real guards.
 */

export const REQUEST_INTENT_SKILL = 'request-intent';

export type ConnectRequestIntent = 'connect_gcal' | 'connect_gmail' | 'connect_gdrive';

export type RequestIntentLabel = ConnectRequestIntent | 'both_free' | 'other';

export const REQUEST_INTENT_LABELS = [
  'connect_gcal',
  'connect_gmail',
  'connect_gdrive',
  'both_free',
  'other',
] as const satisfies readonly RequestIntentLabel[];

/**
 * A request the model was not sure of is not acted on (the skill states the same floor).
 * Higher than the check-in's 0.6: a false connect claim mints a credential link nobody
 * asked for.
 */
export const REQUEST_INTENT_CONFIDENCE_MIN = 0.7;

export type RequestSetting = 'own_thread' | 'household_group';

export interface RequestIntentInput {
  message: string;
  language: ReplyLanguage;
  setting: RequestSetting;
}

/** What the model returns through the forced `intent` tool. */
export interface RequestIntentAnswer {
  intent: RequestIntentLabel;
  verbatim: string;
  rationale: string;
  confidence: number;
}

export interface RequestIntentReading {
  intent: RequestIntentLabel;
  /** One short phrase from the model, or the guard that overrode it. Never the parent's words. */
  interpretation: string;
}

export const PROVIDER_OF_INTENT: Record<ConnectRequestIntent, 'gcal' | 'gmail' | 'gdrive'> = {
  connect_gcal: 'gcal',
  connect_gmail: 'gmail',
  connect_gdrive: 'gdrive',
};

export function isConnectIntent(intent: RequestIntentLabel): intent is ConnectRequestIntent {
  return intent in PROVIDER_OF_INTENT;
}

/** The user-turn payload. The eval builds the same request through this function. */
export function requestIntentUserMessage(input: RequestIntentInput): string {
  return JSON.stringify({
    message: input.message,
    language: input.language,
    setting: input.setting,
  });
}

/**
 * The guards between the model's answer and anything code does with it. Every override
 * lands on `other` — the reading that claims nothing and hands the turn to the coach:
 *
 *   · VERBATIM. The model must echo the message character for character, or it did not
 *     read the message it was given.
 *   · CONFIDENCE, on every non-`other` label. A missed request costs one coach turn; a
 *     false one costs a minted link or a planned window.
 *   · SETTING. A both-free ask is a household-group question; one parent in their own
 *     thread has nobody to be free with here.
 */
export function settleRequestIntent(
  answer: RequestIntentAnswer,
  input: RequestIntentInput,
): RequestIntentReading {
  if (answer.verbatim !== input.message) {
    return { intent: 'other', interpretation: 'verbatim mismatch - the reading was discarded' };
  }
  if (answer.intent !== 'other' && answer.confidence < REQUEST_INTENT_CONFIDENCE_MIN) {
    return { intent: 'other', interpretation: 'request read below confidence floor' };
  }
  if (answer.intent === 'both_free' && input.setting !== 'household_group') {
    return { intent: 'other', interpretation: 'both-free ask outside the household group' };
  }
  return { intent: answer.intent, interpretation: answer.rationale };
}
