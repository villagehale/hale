import type { WeekPlanItem } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { groupItemsByDay, itemNeedsOk, provenanceLabel } from './week-plan-card';

/**
 * The pure receipt logic behind the /plan "week ahead" section (VIL-218 · B2 parity):
 * the kind→provenance map, the "needs your OK" predicate, and the by-day grouping —
 * all read from B1's persisted artifact so the receipt and the Sunday text agree.
 */

function item(overrides: Partial<WeekPlanItem> = {}): WeekPlanItem {
  return {
    kind: 'village',
    title: 'swim class',
    childIds: [],
    startsAt: null,
    endsAt: null,
    location: null,
    sourceRef: null,
    needs: 'none',
    privacySensitive: false,
    ...overrides,
  };
}

describe('provenanceLabel', () => {
  it('names each kind the way the Sunday text does', () => {
    expect(provenanceLabel('routine')).toBe('from your routines');
    expect(provenanceLabel('village')).toBe('you saved this in Village');
    expect(provenanceLabel('birthday')).toBe('a birthday');
    expect(provenanceLabel('appointment')).toBe('an appointment');
    expect(provenanceLabel('suggestion')).toBe('an idea');
  });
});

describe('itemNeedsOk', () => {
  it('is true only when the item still asks something of the parent', () => {
    expect(itemNeedsOk(item({ needs: 'none' }))).toBe(false);
    expect(itemNeedsOk(item({ needs: 'calendar_add' }))).toBe(true);
    expect(itemNeedsOk(item({ needs: 'decision' }))).toBe(true);
  });
});

describe('groupItemsByDay', () => {
  it('buckets dated items by day ascending, out-of-order input notwithstanding', () => {
    const groups = groupItemsByDay([
      item({ startsAt: '2026-07-08', title: 'thu' }),
      item({ startsAt: '2026-07-06', title: 'mon' }),
    ]);
    expect(groups.map((g) => g.dayKey)).toEqual(['2026-07-06', '2026-07-08']);
  });

  it('collects same-day items in input order under one group', () => {
    const groups = groupItemsByDay([
      item({ startsAt: '2026-07-06', title: 'first' }),
      item({ startsAt: '2026-07-08', title: 'other-day' }),
      item({ startsAt: '2026-07-06', title: 'second' }),
    ]);
    const monday = groups.find((g) => g.dayKey === '2026-07-06');
    expect(monday?.items.map((i) => i.title)).toEqual(['first', 'second']);
  });

  it('puts day-coarse (null startsAt) items in a single trailing group', () => {
    const groups = groupItemsByDay([
      item({ startsAt: null, title: 'routine' }),
      item({ startsAt: '2026-07-06', title: 'dated' }),
    ]);
    expect(groups.map((g) => g.dayKey)).toEqual(['2026-07-06', null]);
    expect(groups.at(-1)?.items.map((i) => i.title)).toEqual(['routine']);
  });

  it('appends no null group when every item is dated', () => {
    const groups = groupItemsByDay([item({ startsAt: '2026-07-06' })]);
    expect(groups.map((g) => g.dayKey)).toEqual(['2026-07-06']);
  });
});
