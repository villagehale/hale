import type { WeekPlanItem } from '@hale/db';
import { describe, expect, it } from 'vitest';
import {
  groupItemsByDay,
  groupWeekByKid,
  itemNeedsOk,
  provenanceLabel,
  todayItems,
} from './week-plan-card';

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

/**
 * VIL-244 · M9 — the receipts-room week view (D4/D20, founder principle). A family
 * with more than one kid must be able to read the week WITHOUT decoding which line
 * belongs to whom: the day comes first, then the kids in a consistent order (oldest
 * first), then the items spanning more than one kid as ONE visual grouping, then the
 * family-wide items.
 *
 * Rule #1 rides on the same arrangement: the who-label is age-derived (the loaded
 * child's stage, i.e. deriveStage), so a 13+ teen reads "your teen" in every position
 * — own group, pair, everyone — never their name.
 */
const MAYA = { id: 'c-maya', name: 'Maya', dateOfBirth: '2018-04-02', stage: 'child' as const };
const LIAM = { id: 'c-liam', name: 'Liam', dateOfBirth: '2021-09-15', stage: 'toddler' as const };
const ADA = { id: 'c-ada', name: 'Ada', dateOfBirth: '2024-01-20', stage: 'newborn' as const };
const TEEN = { id: 'c-teen', name: 'Rae', dateOfBirth: '2010-03-01', stage: 'teenager' as const };

describe('groupWeekByKid', () => {
  it('a one-kid family gets a single named grouping per day', () => {
    const sections = groupWeekByKid(
      [item({ startsAt: '2026-07-06', title: 'swim', childIds: [MAYA.id] })],
      [MAYA],
    );
    expect(sections.map((s) => s.dayKey)).toEqual(['2026-07-06']);
    expect(sections[0]?.groups.map((g) => g.who)).toEqual(['Maya']);
  });

  it('orders a two-kid day oldest first, whatever order the artifact stored', () => {
    const sections = groupWeekByKid(
      [
        item({ startsAt: '2026-07-06', title: 'nap', childIds: [LIAM.id] }),
        item({ startsAt: '2026-07-06', title: 'swim', childIds: [MAYA.id] }),
      ],
      [LIAM, MAYA],
    );
    expect(sections[0]?.groups.map((g) => g.who)).toEqual(['Maya', 'Liam']);
  });

  it('orders a three-kid day oldest first and keeps each kid’s items together', () => {
    const sections = groupWeekByKid(
      [
        item({ startsAt: '2026-07-06', title: 'tummy time', childIds: [ADA.id] }),
        item({ startsAt: '2026-07-06', title: 'swim', childIds: [MAYA.id] }),
        item({ startsAt: '2026-07-06', title: 'nap', childIds: [LIAM.id] }),
        item({ startsAt: '2026-07-06', title: 'library', childIds: [MAYA.id] }),
      ],
      [ADA, LIAM, MAYA],
    );
    expect(sections[0]?.groups.map((g) => g.who)).toEqual(['Maya', 'Liam', 'Ada']);
    expect(sections[0]?.groups[0]?.items.map((i) => i.title)).toEqual(['swim', 'library']);
  });

  it('calls a shared item "Both" in a two-kid family and files it after the per-kid groups', () => {
    const sections = groupWeekByKid(
      [
        item({ startsAt: '2026-07-06', title: 'zoo', childIds: [MAYA.id, LIAM.id] }),
        item({ startsAt: '2026-07-06', title: 'swim', childIds: [MAYA.id] }),
      ],
      [MAYA, LIAM],
    );
    expect(sections[0]?.groups.map((g) => g.who)).toEqual(['Maya', 'Both']);
  });

  it('calls a whole-family item "Everyone" once there are three kids', () => {
    const sections = groupWeekByKid(
      [item({ startsAt: '2026-07-06', title: 'zoo', childIds: [MAYA.id, LIAM.id, ADA.id] })],
      [MAYA, LIAM, ADA],
    );
    expect(sections[0]?.groups.map((g) => g.who)).toEqual(['Everyone']);
  });

  it('names the actual pair when an item spans SOME of three kids — never a fabricated "Everyone"', () => {
    const sections = groupWeekByKid(
      [item({ startsAt: '2026-07-06', title: 'zoo', childIds: [LIAM.id, MAYA.id] })],
      [MAYA, LIAM, ADA],
    );
    expect(sections[0]?.groups.map((g) => g.who)).toEqual(['Maya & Liam']);
  });

  it('gives a family-wide item (no childIds) no who-label, filed last', () => {
    const sections = groupWeekByKid(
      [
        item({ startsAt: '2026-07-06', title: 'market', childIds: [] }),
        item({ startsAt: '2026-07-06', title: 'swim', childIds: [MAYA.id] }),
      ],
      [MAYA, LIAM],
    );
    expect(sections[0]?.groups.map((g) => g.who)).toEqual(['Maya', null]);
  });

  it('keeps a 13+ teen generic in every position (rule #1) — own group and pair', () => {
    const sections = groupWeekByKid(
      [
        item({ startsAt: '2026-07-06', title: 'a checkup', childIds: [TEEN.id] }),
        item({ startsAt: '2026-07-06', title: 'zoo', childIds: [TEEN.id, MAYA.id] }),
      ],
      [TEEN, MAYA],
    );
    const labels = sections[0]?.groups.map((g) => g.who) ?? [];
    expect(labels).toEqual(['your teen', 'Both']);
    expect(labels.join(' ')).not.toContain(TEEN.name);
  });

  it('never names a teen inside a partial pair either', () => {
    const sections = groupWeekByKid(
      [item({ startsAt: '2026-07-06', title: 'zoo', childIds: [TEEN.id, MAYA.id] })],
      [TEEN, MAYA, ADA],
    );
    expect(sections[0]?.groups.map((g) => g.who)).toEqual(['your teen & Maya']);
  });

  it('groups a day by its CALENDAR day, so two clock times on one date stay one day', () => {
    const sections = groupWeekByKid(
      [
        item({ startsAt: '2026-07-06T10:30', title: 'storytime', childIds: [LIAM.id] }),
        item({ startsAt: '2026-07-06T14:00', title: 'farm', childIds: [MAYA.id, LIAM.id] }),
        item({ startsAt: '2026-07-06', title: 'swim', childIds: [MAYA.id] }),
      ],
      [MAYA, LIAM],
    );
    expect(sections.map((s) => s.dayKey)).toEqual(['2026-07-06']);
    expect(sections[0]?.groups.map((g) => g.who)).toEqual(['Maya', 'Liam', 'Both']);
  });

  it('keeps the day spine: days ascending, day-coarse items last', () => {
    const sections = groupWeekByKid(
      [
        item({ startsAt: null, title: 'routine', childIds: [MAYA.id] }),
        item({ startsAt: '2026-07-08', title: 'thu', childIds: [MAYA.id] }),
        item({ startsAt: '2026-07-06', title: 'mon', childIds: [MAYA.id] }),
      ],
      [MAYA],
    );
    expect(sections.map((s) => s.dayKey)).toEqual(['2026-07-06', '2026-07-08', null]);
  });

  it('falls back to an unattributed group when the artifact names a child the family no longer has', () => {
    const sections = groupWeekByKid(
      [item({ startsAt: '2026-07-06', title: 'swim', childIds: ['c-gone'] })],
      [MAYA],
    );
    expect(sections[0]?.groups.map((g) => g.who)).toEqual([null]);
  });
});

describe('todayItems', () => {
  it('keeps only the items dated on the family’s today, ignoring any clock time', () => {
    const kept = todayItems(
      [
        item({ startsAt: '2026-07-06T09:30', title: 'today-timed' }),
        item({ startsAt: '2026-07-06', title: 'today-bare' }),
        item({ startsAt: '2026-07-07', title: 'tomorrow' }),
        item({ startsAt: null, title: 'day-coarse' }),
      ],
      '2026-07-06',
    );
    expect(kept.map((i) => i.title)).toEqual(['today-timed', 'today-bare']);
  });
});
