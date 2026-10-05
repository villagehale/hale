import { describe, expect, it } from 'vitest';
import {
  CADENCE_OF_INTENT,
  CHECK_IN_CADENCE_CONFIDENCE_MIN,
  CHECK_IN_INTENT_LABELS,
  type CheckInIntentAnswer,
  type CheckInIntentInput,
  checkInIntentUserMessage,
  isCadenceIntent,
  settleCheckInIntent,
} from './intent-reading';

/**
 * The guards between the model's reading and anything code does with it. Whether the
 * real model reads a parent well is the cached eval's job
 * (apps/worker/evals/run-checkin-intent-eval.mjs, rule #8).
 */

const INPUT: CheckInIntentInput = {
  reply: 'less often please',
  language: 'en',
  questionStanding: true,
  cadence: 'daily',
};

function answer(overrides: Partial<CheckInIntentAnswer> = {}): CheckInIntentAnswer {
  return {
    intent: 'cadence_weekly',
    verbatim: INPUT.reply,
    rationale: 'asks for the question less often',
    confidence: 0.92,
    ...overrides,
  };
}

describe('checkInIntentUserMessage', () => {
  it('sends the reply, its language, whether a question is open, and the cadence - nothing else', () => {
    expect(JSON.parse(checkInIntentUserMessage(INPUT))).toEqual({
      reply: 'less often please',
      language: 'en',
      questionStanding: true,
      cadence: 'daily',
    });
  });
});

describe('the cadence table', () => {
  it('names exactly the three cadence intents and maps each to a stored cadence', () => {
    expect(CHECK_IN_INTENT_LABELS.filter(isCadenceIntent)).toEqual([
      'cadence_weekly',
      'cadence_off',
      'cadence_daily',
    ]);
    expect(CADENCE_OF_INTENT).toEqual({
      cadence_weekly: 'weekly',
      cadence_off: 'off',
      cadence_daily: 'daily',
    });
    expect(isCadenceIntent('day_note')).toBe(false);
    expect(isCadenceIntent('request')).toBe(false);
    expect(isCadenceIntent('other')).toBe(false);
  });
});

describe('settleCheckInIntent', () => {
  it('passes a confident cadence read through with the model phrase as the interpretation', () => {
    expect(settleCheckInIntent(answer(), INPUT)).toEqual({
      intent: 'cadence_weekly',
      interpretation: 'asks for the question less often',
    });
  });

  it('discards the whole reading when the echo is not the reply, character for character', () => {
    for (const verbatim of ['Less often please', 'less often please ', 'less often', '']) {
      expect(settleCheckInIntent(answer({ verbatim }), INPUT)).toEqual({
        intent: 'other',
        interpretation: 'verbatim mismatch - the reading was discarded',
      });
    }
  });

  it('does not change a cadence on a read below the confidence floor', () => {
    const low = answer({ confidence: CHECK_IN_CADENCE_CONFIDENCE_MIN - 0.01 });
    expect(settleCheckInIntent(low, INPUT).intent).toBe('other');
    const atFloor = answer({ confidence: CHECK_IN_CADENCE_CONFIDENCE_MIN });
    expect(settleCheckInIntent(atFloor, INPUT).intent).toBe('cadence_weekly');
  });

  it('keeps a day note or a request however unsure the model was', () => {
    const note = answer({
      intent: 'day_note',
      confidence: 0.2,
      rationale: 'tells how the day went',
    });
    expect(settleCheckInIntent(note, INPUT)).toEqual({
      intent: 'day_note',
      interpretation: 'tells how the day went',
    });
    const request = answer({ intent: 'request', confidence: 0.3, rationale: 'asks Hale to find' });
    expect(settleCheckInIntent(request, INPUT).intent).toBe('request');
  });

  it('treats a wish for the cadence the family already has as nothing to do', () => {
    const daily = answer({ intent: 'cadence_daily', verbatim: 'every night please' });
    const input: CheckInIntentInput = { ...INPUT, reply: 'every night please', cadence: 'daily' };
    expect(settleCheckInIntent(daily, input)).toEqual({
      intent: 'other',
      interpretation: 'cadence already as asked',
    });
    expect(settleCheckInIntent(daily, { ...input, cadence: 'weekly' }).intent).toBe(
      'cadence_daily',
    );
  });
});
