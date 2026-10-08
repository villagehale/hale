import { describe, expect, it, vi } from 'vitest';
import { decideForFamily, parseDeciderDecision } from './decide';
import { type FamilySnapshot, formatSnapshotLocalNow } from './snapshot';

const NOW = new Date('2026-10-08T14:00:00.000Z');

const SNAPSHOT: FamilySnapshot = {
  timeZone: 'America/Toronto',
  now: NOW.toISOString(),
  localNow: formatSnapshotLocalNow(NOW, 'America/Toronto'),
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

describe('parseDeciderDecision', () => {
  it('reads send, hold, drop, and a cadence preference', () => {
    const decision = parseDeciderDecision(
      '{"action":"hold","hold_until":"2026-10-09T12:00:00Z","item_ids":["a"],"reason":"two unanswered","frequency_preference":{"direction":"less","note":"text me less"}}',
    );
    expect(decision).toEqual({
      action: 'hold',
      holdUntil: '2026-10-09T12:00:00Z',
      itemIds: ['a'],
      reason: 'two unanswered',
      frequencyPreference: { direction: 'less', note: 'text me less' },
    });
  });

  it('rejects a missing reason', () => {
    expect(parseDeciderDecision('{"action":"drop","item_ids":[],"reason":""}')).toBeNull();
  });
});

describe('decideForFamily', () => {
  it('does not call the model when the queue is empty', async () => {
    const client = { messages: { create: vi.fn() } };
    const result = await decideForFamily({
      snapshot: SNAPSHOT,
      client: client as never,
      database: {} as never,
      familyId: 'fam',
    });
    expect(result.skipped).toBe('empty_queue');
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('names a missing client and does not send', async () => {
    const result = await decideForFamily({
      snapshot: {
        ...SNAPSHOT,
        candidates: [
          {
            id: 'c1',
            what: 'Lantern craft',
            why: 'saved find',
            sourceUrl: 'https://tpl.example/lantern',
            worthlessAfter: null,
            parentRequested: false,
            dedupeKey: 'lantern',
          },
        ],
      },
      client: null,
      database: {} as never,
      familyId: 'fam',
    });
    expect(result).toEqual({ decision: null, skipped: 'no_client' });
  });
});
