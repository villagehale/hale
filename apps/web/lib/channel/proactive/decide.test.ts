import { describe, expect, it } from 'vitest';
import { DECIDER_TOOL_SCHEMA, decideForFamily, parseDeciderDecision } from './decide';
import type { FamilySnapshot } from './snapshot';

const SNAPSHOT: FamilySnapshot = {
  timeZone: 'America/New_York',
  now: '2026-10-08T22:00:00.000Z',
  localNow: 'Thursday 6:00 PM America/New_York',
  household: { areaCoarse: null, childAgesYears: [] },
  calendar: [],
  freeWindows: [],
  deadlines: [],
  watches: [],
  candidates: [],
  recentSends: [],
  unansweredStreak: 0,
  frequencyPreference: null,
  declines: [],
  recentParentTexts: [],
  priorDecisions: [],
};

const CANDIDATE = {
  id: 'c1',
  kind: 'nudge',
  why: 'empty_saturday',
  sourceUrl: 'https://example.test/lantern',
  worthlessAfter: null,
  parentRequested: false,
};

/** A client that records whether it was reached. It never answers: no model is mocked. */
function untouchedClient() {
  const calls: unknown[] = [];
  const refuse = (params: unknown) => {
    calls.push(params);
    throw new Error('the model must not be called');
  };
  return {
    calls,
    client: { messages: { create: refuse, stream: refuse } } as never,
  };
}

describe('the decider tool schema', () => {
  it('asks for the reason before the action, and allows nothing else', () => {
    expect(Object.keys(DECIDER_TOOL_SCHEMA.properties ?? {})).toEqual([
      'reason',
      'action',
      'item_ids',
      'hold_until',
      'frequency_preference',
    ]);
    expect(DECIDER_TOOL_SCHEMA.additionalProperties).toBe(false);
    expect(DECIDER_TOOL_SCHEMA.required).toEqual([
      'reason',
      'action',
      'item_ids',
      'hold_until',
      'frequency_preference',
    ]);
  });
});

describe('parseDeciderDecision', () => {
  it('reads send, hold, drop, and a cadence preference', () => {
    expect(
      parseDeciderDecision({
        reason: 'two texts unanswered',
        action: 'hold',
        item_ids: ['a'],
        hold_until: '2026-10-09T12:00:00Z',
        frequency_preference: { direction: 'less', note: 'text me less' },
      }),
    ).toEqual({
      reason: 'two texts unanswered',
      action: 'hold',
      itemIds: ['a'],
      holdUntil: '2026-10-09T12:00:00Z',
      frequencyPreference: { direction: 'less', note: 'text me less' },
    });
  });

  it('rejects a blank reason, an unknown action, and an extra key', () => {
    const base = {
      reason: 'fits Saturday',
      action: 'send_now',
      item_ids: ['a'],
      hold_until: null,
      frequency_preference: null,
    };
    expect(parseDeciderDecision({ ...base, reason: '  ' })).toBeNull();
    expect(parseDeciderDecision({ ...base, action: 'later' })).toBeNull();
    expect(parseDeciderDecision({ ...base, text: 'hi' })).toBeNull();
    expect(parseDeciderDecision(base)?.action).toBe('send_now');
  });

  it('rejects a hold time that is not a time', () => {
    expect(
      parseDeciderDecision({
        reason: 'early',
        action: 'hold',
        item_ids: ['a'],
        hold_until: 'Friday evening',
        frequency_preference: null,
      }),
    ).toBeNull();
  });
});

describe('decideForFamily', () => {
  it('does not call the model when the queue is empty', async () => {
    const { calls, client } = untouchedClient();
    const result = await decideForFamily({ snapshot: SNAPSHOT, client });
    expect(result).toEqual({ decision: null, skipped: 'empty_queue' });
    expect(calls).toEqual([]);
  });

  it('names a missing client and does not send', async () => {
    const result = await decideForFamily({
      snapshot: { ...SNAPSHOT, candidates: [CANDIDATE] },
      client: null,
    });
    expect(result).toEqual({ decision: null, skipped: 'no_client' });
  });
});
