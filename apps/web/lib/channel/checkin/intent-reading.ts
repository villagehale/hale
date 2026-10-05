import type { ReplyLanguage } from '../language';

/**
 * VIL-413 / VIL-417 · what a parent's reply in the evening lane MEANS, as the model reads
 * it, and the two guards code keeps on that reading.
 *
 * Until this change the lane taught three words — LESS, NO, DAILY — and matched them
 * whole-string (`readCadenceWord`). Founder rule, 2026-10-04: Hale never asks a parent to
 * reply with a keyword. So the words are no longer printed, and the reading is no longer
 * a lookup: the model says whether the parent wants the question less often, gone, or
 * back, is telling Hale about their day, is asking Hale for something, or none of those.
 * Code stores the cadence and enforces the limits; it never writes a parent-facing word.
 *
 * Pure, relative imports only: the worker eval loads this module through tsx and
 * settles the real model's answers through the real guards.
 */

export const CHECKIN_INTENT_SKILL = 'checkin-intent';

export type CheckInCadenceIntent = 'cadence_weekly' | 'cadence_off' | 'cadence_daily';

export type CheckInIntentLabel = CheckInCadenceIntent | 'day_note' | 'request' | 'other';

export const CHECK_IN_INTENT_LABELS = [
  'cadence_weekly',
  'cadence_off',
  'cadence_daily',
  'day_note',
  'request',
  'other',
] as const satisfies readonly CheckInIntentLabel[];

/** A cadence read the model was not sure of is not acted on (the skill states the same floor). */
export const CHECK_IN_CADENCE_CONFIDENCE_MIN = 0.6;

export interface CheckInIntentInput {
  reply: string;
  language: ReplyLanguage;
  /** Hale asked tonight and the question is still open. */
  questionStanding: boolean;
  /** How often Hale asks this family right now. */
  cadence: 'daily' | 'weekly' | 'off';
}

/** What the model returns through the forced `intent` tool. */
export interface CheckInIntentAnswer {
  intent: CheckInIntentLabel;
  verbatim: string;
  rationale: string;
  confidence: number;
}

export interface CheckInIntentReading {
  intent: CheckInIntentLabel;
  /** One short phrase from the model, or the guard that overrode it. Never the parent's words. */
  interpretation: string;
}

export const CADENCE_OF_INTENT: Record<CheckInCadenceIntent, 'weekly' | 'off' | 'daily'> = {
  cadence_weekly: 'weekly',
  cadence_off: 'off',
  cadence_daily: 'daily',
};

export function isCadenceIntent(intent: CheckInIntentLabel): intent is CheckInCadenceIntent {
  return intent in CADENCE_OF_INTENT;
}

/** The user-turn payload. The eval builds the same request through this function. */
export function checkInIntentUserMessage(input: CheckInIntentInput): string {
  return JSON.stringify({
    reply: input.reply,
    language: input.language,
    questionStanding: input.questionStanding,
    cadence: input.cadence,
  });
}

/**
 * The guards between the model's answer and anything code does with it. Every override
 * lands on `other` — the reading that claims nothing and hands the turn to the coach —
 * because the conservative direction here is always "do not change how often a family
 * hears from Hale on a guess":
 *
 *   · VERBATIM. The model must echo the reply character for character. A paraphrase means
 *     it did not read the message it was given, and its verdict is not evidence.
 *   · CONFIDENCE, on cadence intents only. A day note or a request the model was unsure
 *     of costs nothing if wrong; a cadence change costs the family a month of evenings.
 *   · ALREADY THERE. "Every night please" from a household already on nightly is not a
 *     change, and acting on it would write a receipt for nothing.
 */
export function settleCheckInIntent(
  answer: CheckInIntentAnswer,
  input: CheckInIntentInput,
): CheckInIntentReading {
  if (answer.verbatim !== input.reply) {
    return { intent: 'other', interpretation: 'verbatim mismatch - the reading was discarded' };
  }
  if (isCadenceIntent(answer.intent)) {
    if (answer.confidence < CHECK_IN_CADENCE_CONFIDENCE_MIN) {
      return { intent: 'other', interpretation: `cadence read below confidence floor` };
    }
    if (CADENCE_OF_INTENT[answer.intent] === input.cadence) {
      return { intent: 'other', interpretation: 'cadence already as asked' };
    }
  }
  return { intent: answer.intent, interpretation: answer.rationale };
}
