import { describe, expect, it } from 'vitest';
import {
  type KidItemClassifier,
  type KidItemsInput,
  acceptKidItemIds,
  kidItemsFor,
  kidRelatedAha,
} from './aha-kids';
import type { AhaSnapshot } from './aha-read';

const context = {
  children: [
    { name: 'Sebastian', ageMonths: 15 },
    { name: 'Mia', ageMonths: 72 },
  ],
  activityTitles: ['Parent and Tot Swim', 'Library drop-in'],
};

function calendar(title: string, start: string, end: string): AhaSnapshot['calendar'][number] {
  return { title, start, end, allDay: false, location: null, declined: false };
}

function email(subject: string, fromName: string | null = null): AhaSnapshot['email'][number] {
  return { subject, fromName, receivedAt: '2026-10-05T14:00:00Z', snippet: null };
}

/** A scripted classifier: the port, not the model. It records what it was handed. */
function scripted(answer: (input: KidItemsInput) => unknown) {
  const calls: KidItemsInput[] = [];
  const classifier: KidItemClassifier = {
    async classify(input) {
      calls.push(input);
      return answer(input);
    },
  };
  return { classifier, calls };
}

describe('kidItemsFor', () => {
  it('hands the classifier every item with a stable id, the kids with ages, and the found activities', () => {
    const snapshot: AhaSnapshot = {
      provider: 'gmail',
      read: 'ok',
      calendar: [],
      email: [
        email('Seb 15-month checkup', 'Dr Patel'),
        {
          subject: 'Coffee next week?',
          fromName: 'Sebastian',
          receivedAt: null,
          snippet: 'Free Tuesday?',
        },
      ],
      overlaps: [],
    };
    const input = kidItemsFor(snapshot, context);
    expect(input.children).toEqual(context.children);
    expect(input.activityTitles).toEqual(context.activityTitles);
    expect(input.items).toEqual([
      { id: 'e0', text: 'Seb 15-month checkup from Dr Patel' },
      { id: 'e1', text: 'Coffee next week? from Sebastian - Free Tuesday?' },
    ]);
  });
});

describe('acceptKidItemIds', () => {
  it('keeps only ids that were offered, and nothing from a malformed answer', () => {
    expect([...acceptKidItemIds({ kidItemIds: ['c0', 'e9', 'x'] }, ['c0', 'e1'])]).toEqual(['c0']);
    expect(acceptKidItemIds({ kidItemIds: 'c0' }, ['c0']).size).toBe(0);
    expect(acceptKidItemIds(null, ['c0']).size).toBe(0);
    expect(acceptKidItemIds('c0', ['c0']).size).toBe(0);
  });
});

describe('kidRelatedAha', () => {
  it('keeps the items the classifier named and recomputes overlaps from the kid items alone', async () => {
    const snapshot: AhaSnapshot = {
      provider: 'gcal',
      read: 'ok',
      calendar: [
        calendar('Mia swim', '2026-10-17T14:00:00Z', '2026-10-17T14:45:00Z'),
        calendar('1:1 with Mia Chen (Product)', '2026-10-17T14:00:00Z', '2026-10-17T14:30:00Z'),
        calendar('Mia birthday party', '2026-10-17T14:15:00Z', '2026-10-17T16:00:00Z'),
        calendar(
          'Rotman School alumni dinner - RSVP',
          '2026-10-20T23:00:00Z',
          '2026-10-21T02:00:00Z',
        ),
      ],
      email: [],
      overlaps: [
        { earlier: 'Mia swim', later: '1:1 with Mia Chen (Product)' },
        { earlier: 'Mia swim', later: 'Mia birthday party' },
      ],
    };
    const { classifier, calls } = scripted(() => ({ kidItemIds: ['c0', 'c2'] }));
    const kept = await kidRelatedAha(snapshot, context, classifier);
    expect(calls).toHaveLength(1);
    expect(kept.read).toBe('ok');
    expect(kept.kidFilter).toBe('kept');
    expect(kept.calendar.map((row) => row.title)).toEqual(['Mia swim', 'Mia birthday party']);
    expect(kept.overlaps).toEqual([{ earlier: 'Mia swim', later: 'Mia birthday party' }]);
  });

  it('a mailbox the classifier reads as all parent yields none_for_kids, never a parent item', async () => {
    const snapshot: AhaSnapshot = {
      provider: 'gmail',
      read: 'ok',
      calendar: [],
      email: [
        email('Rotman School alumni dinner - RSVP'),
        email('Baby shower for Jen'),
        email('Library hold ready: Atomic Habits'),
        email('Coffee next week?', 'Sebastian'),
      ],
      overlaps: [],
    };
    const { classifier } = scripted(() => ({ kidItemIds: [] }));
    const kept = await kidRelatedAha(snapshot, context, classifier);
    expect(kept.read).toBe('none_for_kids');
    expect(kept.kidFilter).toBe('none_for_kids');
    expect(kept.email).toEqual([]);
  });

  it('ids the classifier invents are dropped; nothing reaches the model that was not offered', async () => {
    const snapshot: AhaSnapshot = {
      provider: 'gmail',
      read: 'ok',
      calendar: [],
      email: [email('Music festival with friends')],
      overlaps: [],
    };
    const { classifier } = scripted(() => ({ kidItemIds: ['e4', 'c0'] }));
    const kept = await kidRelatedAha(snapshot, context, classifier);
    expect(kept.read).toBe('none_for_kids');
  });

  it('a read that already failed or was withheld passes through without a classifier call', async () => {
    const { classifier, calls } = scripted(() => ({ kidItemIds: [] }));
    const failed: AhaSnapshot = {
      provider: 'gmail',
      read: 'failed',
      calendar: [],
      email: [],
      overlaps: [],
    };
    const withheld: AhaSnapshot = {
      provider: 'gmail',
      read: 'withheld',
      calendar: [],
      email: [],
      overlaps: [],
    };
    const empty: AhaSnapshot = {
      provider: 'gcal',
      read: 'empty',
      calendar: [],
      email: [],
      overlaps: [],
    };
    expect((await kidRelatedAha(failed, context, classifier)).read).toBe('failed');
    expect((await kidRelatedAha(withheld, context, classifier)).read).toBe('withheld');
    expect((await kidRelatedAha(empty, context, classifier)).read).toBe('empty');
    expect(calls).toHaveLength(0);
  });

  it('no classifier keeps nothing and names why (rule #11)', async () => {
    const snapshot: AhaSnapshot = {
      provider: 'gcal',
      read: 'ok',
      calendar: [calendar('Mia swim', '2026-10-17T14:00:00Z', '2026-10-17T14:45:00Z')],
      email: [],
      overlaps: [],
    };
    const kept = await kidRelatedAha(snapshot, context, undefined);
    expect(kept.read).toBe('none_for_kids');
    expect(kept.kidFilter).toBe('classifier_unavailable');
    expect(kept.calendar).toEqual([]);
  });

  it('a classifier that throws keeps nothing and names why', async () => {
    const snapshot: AhaSnapshot = {
      provider: 'gcal',
      read: 'ok',
      calendar: [calendar('Mia swim', '2026-10-17T14:00:00Z', '2026-10-17T14:45:00Z')],
      email: [],
      overlaps: [],
    };
    const classifier: KidItemClassifier = {
      async classify() {
        throw new Error('boom');
      },
    };
    const kept = await kidRelatedAha(snapshot, context, classifier);
    expect(kept.read).toBe('none_for_kids');
    expect(kept.kidFilter).toBe('classifier_failed');
  });
});
