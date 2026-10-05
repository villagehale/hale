import { describe, expect, it } from 'vitest';
import {
  PROVIDER_OF_INTENT,
  REQUEST_INTENT_CONFIDENCE_MIN,
  REQUEST_INTENT_LABELS,
  type RequestIntentAnswer,
  type RequestIntentInput,
  isConnectIntent,
  requestIntentUserMessage,
  settleRequestIntent,
} from './request-intent-reading';

/**
 * The guards between the model's reading and anything code does with it. Whether the
 * real model reads a parent well is the cached eval's job
 * (apps/worker/evals/run-request-intent-eval.mjs, rule #8).
 */

const INPUT: RequestIntentInput = {
  message: 'can you hook up my google calendar',
  language: 'en',
  setting: 'own_thread',
};

function answer(overrides: Partial<RequestIntentAnswer> = {}): RequestIntentAnswer {
  return {
    intent: 'connect_gcal',
    verbatim: INPUT.message,
    rationale: 'asks to connect their calendar',
    confidence: 0.93,
    ...overrides,
  };
}

describe('requestIntentUserMessage', () => {
  it('sends the message, its language and the setting - nothing else', () => {
    expect(JSON.parse(requestIntentUserMessage(INPUT))).toEqual({
      message: 'can you hook up my google calendar',
      language: 'en',
      setting: 'own_thread',
    });
  });
});

describe('the connect table', () => {
  it('names exactly the three connect intents and maps each to a provider', () => {
    expect(REQUEST_INTENT_LABELS.filter(isConnectIntent)).toEqual([
      'connect_gcal',
      'connect_gmail',
      'connect_gdrive',
    ]);
    expect(PROVIDER_OF_INTENT).toEqual({
      connect_gcal: 'gcal',
      connect_gmail: 'gmail',
      connect_gdrive: 'gdrive',
    });
    expect(isConnectIntent('both_free')).toBe(false);
    expect(isConnectIntent('other')).toBe(false);
  });
});

describe('settleRequestIntent', () => {
  it('passes a confident connect read through with the model phrase as the interpretation', () => {
    expect(settleRequestIntent(answer(), INPUT)).toEqual({
      intent: 'connect_gcal',
      interpretation: 'asks to connect their calendar',
    });
  });

  it('discards the whole reading when the echo is not the message, character for character', () => {
    for (const verbatim of [
      'Can you hook up my google calendar',
      'can you hook up my google calendar ',
      'hook up my google calendar',
      '',
    ]) {
      expect(settleRequestIntent(answer({ verbatim }), INPUT)).toEqual({
        intent: 'other',
        interpretation: 'verbatim mismatch - the reading was discarded',
      });
    }
  });

  it('reads other below the floor for every actionable label, and the floor is 0.7', () => {
    expect(REQUEST_INTENT_CONFIDENCE_MIN).toBe(0.7);
    for (const intent of ['connect_gcal', 'connect_gmail', 'connect_gdrive'] as const) {
      expect(settleRequestIntent(answer({ intent, confidence: 0.69 }), INPUT)).toEqual({
        intent: 'other',
        interpretation: 'request read below confidence floor',
      });
      expect(settleRequestIntent(answer({ intent, confidence: 0.7 }), INPUT).intent).toBe(intent);
    }
    const group: RequestIntentInput = { ...INPUT, setting: 'household_group' };
    expect(
      settleRequestIntent(answer({ intent: 'both_free', confidence: 0.5 }), group).intent,
    ).toBe('other');
  });

  it('does not apply the floor to other - an unsure other is still other', () => {
    expect(
      settleRequestIntent(
        answer({ intent: 'other', confidence: 0.2, rationale: 'chit-chat' }),
        INPUT,
      ),
    ).toEqual({ intent: 'other', interpretation: 'chit-chat' });
  });

  it('keeps a both-free ask inside the household group - one parent alone has nobody to be free with', () => {
    const own = settleRequestIntent(answer({ intent: 'both_free' }), INPUT);
    expect(own).toEqual({
      intent: 'other',
      interpretation: 'both-free ask outside the household group',
    });
    const group = settleRequestIntent(
      answer({ intent: 'both_free', rationale: 'asks when both are free' }),
      {
        ...INPUT,
        setting: 'household_group',
      },
    );
    expect(group).toEqual({ intent: 'both_free', interpretation: 'asks when both are free' });
  });
});
