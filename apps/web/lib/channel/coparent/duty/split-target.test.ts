import { describe, expect, it } from 'vitest';
import { resolveSplitReminderOwner, splitReminderDecision } from './split-target';

const NINE = new Date('2026-09-28T13:00:00.000Z');
const TEN = new Date('2026-09-28T14:00:00.000Z');
const TEN_THIRTY = new Date('2026-09-28T14:30:00.000Z');

const hockey = {
  eventKey: 'hockey',
  childId: 'maya',
  kid: 'Maya',
  startsAt: NINE,
  endsAt: TEN,
  ownerUserId: null as string | null,
};
const dance = {
  eventKey: 'dance',
  childId: 'leo',
  kid: 'Leo',
  startsAt: NINE,
  endsAt: TEN_THIRTY,
  ownerUserId: null as string | null,
};

describe('splitReminderDecision', () => {
  it('does not assume a driver when nobody answered', () => {
    expect(
      splitReminderDecision({
        event: hockey,
        siblings: [dance],
        parentUserId: 'ana',
      }),
    ).toEqual({ action: 'suppress', reason: 'split_unassigned' });
  });

  it('reminds only the parent who has that kid', () => {
    const splitHockey = { ...hockey, ownerUserId: 'ana' };
    const splitDance = { ...dance, ownerUserId: 'sam' };
    expect(
      splitReminderDecision({
        event: splitHockey,
        siblings: [splitDance],
        parentUserId: 'ana',
      }),
    ).toEqual({ action: 'fire' });
    expect(
      splitReminderDecision({
        event: splitHockey,
        siblings: [splitDance],
        parentUserId: 'sam',
      }),
    ).toEqual({ action: 'suppress', reason: 'split_other_driver' });
  });

  it('reminds the one parent who takes both', () => {
    const bothHockey = { ...hockey, ownerUserId: 'ana' };
    const bothDance = { ...dance, ownerUserId: 'ana' };
    expect(
      splitReminderDecision({
        event: bothHockey,
        siblings: [bothDance],
        parentUserId: 'ana',
      }),
    ).toEqual({ action: 'fire' });
    expect(
      splitReminderDecision({
        event: bothHockey,
        siblings: [bothDance],
        parentUserId: 'sam',
      }),
    ).toEqual({ action: 'suppress', reason: 'split_other_driver' });
  });

  it('resolves a duty owner from the Google event id when the column is empty', () => {
    const owners = new Map([['gcal-hockey', 'ana']]);
    expect(
      resolveSplitReminderOwner(
        { id: 'fe-1', dutyOwnerUserId: null, googleEventId: 'gcal-hockey' },
        owners,
      ),
    ).toBe('ana');
    expect(
      resolveSplitReminderOwner(
        { id: 'fe-1', dutyOwnerUserId: null, placedGoogleEventId: 'gcal-hockey' },
        owners,
      ),
    ).toBe('ana');
  });

  it('leaves a non-overlapping event alone', () => {
    expect(
      splitReminderDecision({
        event: hockey,
        siblings: [
          {
            ...dance,
            startsAt: new Date('2026-09-29T13:00:00.000Z'),
            endsAt: new Date('2026-09-29T14:00:00.000Z'),
          },
        ],
        parentUserId: 'ana',
      }),
    ).toEqual({ action: 'fire' });
  });
});
