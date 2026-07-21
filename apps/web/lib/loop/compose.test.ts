import type { WeekPlanItem } from '@hale/db';
import { describe, expect, it } from 'vitest';
import type { WeekWindow } from '~/lib/plan/spine';
import {
  APPOINTMENT_HORIZON_WEEKS,
  type ComposeInputs,
  composeWeekPlan,
  MAX_ITEMS,
} from './compose';

// Destructuring default so `item` narrows to WeekPlanItem (not `| undefined`) for
// strict tsc; an empty compose result yields this sentinel, whose title fails every
// assertion — so a wrongly-empty plan still surfaces as a red test.
const MISSING_ITEM: WeekPlanItem = {
  kind: 'routine',
  title: '<<no item>>',
  childIds: [],
  startsAt: null,
  endsAt: null,
  location: null,
  sourceRef: null,
  needs: 'none',
  privacySensitive: false,
};

/**
 * The deterministic composer is the substance of the Sunday plan, so these assert
 * every rule from the ticket directly — item kinds, the appointment horizon, teen
 * redaction (generic title, no name, no health detail), in-window filtering,
 * ranking, and the ≤8 cap with routine-overflow collapse. Expected values are
 * derived from the spec, never read back from the composer.
 */

const WINDOW: WeekWindow = {
  startKey: '2026-07-27',
  endKey: '2026-08-02',
  dayKeys: ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'],
};
const NOW = new Date('2026-07-27T12:00:00Z');

const BABY = 'a1111111-1111-4111-8111-111111111111'; // non-teen
const TEEN = 'b2222222-2222-4222-8222-222222222222'; // teen
// Default DOBs: birthdays OUT of the July window so the base fixture is truly empty
// (birthday tests opt in with an in-window DOB). Ages keep baby non-teen, teen 13+.
const BABY_DOB = '2025-11-15';
const TEEN_DOB = '2010-11-20';
const BABY_DOB_IN_WINDOW = '2025-07-30'; // birthday 2026-07-30, in [07-27, 08-02]
const TEEN_DOB_IN_WINDOW = '2010-07-31'; // birthday 2026-07-31, in-window

function inputs(over: Partial<ComposeInputs> = {}): ComposeInputs {
  return {
    window: WINDOW,
    children: [
      { id: BABY, name: 'Maya', dateOfBirth: BABY_DOB },
      { id: TEEN, name: 'Sam', dateOfBirth: TEEN_DOB },
    ],
    health: [],
    routines: [],
    villageDated: [],
    suggestion: null,
    familyEvents: [],
    ...over,
  };
}

describe('composeWeekPlan — empty + appointments', () => {
  it('an empty week composes to an empty item list (still a real artifact)', () => {
    expect(composeWeekPlan(inputs(), NOW)).toEqual([]);
  });

  it("names a non-teen child's checkup, flags it privacy_sensitive, and leaves it undated", () => {
    const [item = MISSING_ITEM] = composeWeekPlan(
      inputs({ health: [{ childId: BABY, what: '15-month checkup', kind: 'well_child_visit', dueInWeeks: 1 }] }),
      NOW,
    );
    expect(item).toMatchObject({
      kind: 'appointment',
      title: 'Maya — 15-month checkup',
      childIds: [BABY],
      startsAt: null,
      needs: 'calendar_add',
      privacySensitive: true,
    });
  });

  it(`drops a health item due beyond the ${APPOINTMENT_HORIZON_WEEKS}-week appointment horizon`, () => {
    const items = composeWeekPlan(
      inputs({ health: [{ childId: BABY, what: 'far checkup', kind: 'well_child_visit', dueInWeeks: 3 }] }),
      NOW,
    );
    expect(items).toEqual([]);
  });

  it('redacts a teen appointment to a generic line — no name, no health detail', () => {
    const [item = MISSING_ITEM] = composeWeekPlan(
      inputs({ health: [{ childId: TEEN, what: 'HPV immunization', kind: 'immunization', dueInWeeks: 0 }] }),
      NOW,
    );
    expect(item.title).toBe('a private appointment for your teen');
    expect(item.title).not.toContain('Sam');
    expect(item.title).not.toContain('HPV');
    expect(item.privacySensitive).toBe(true);
  });
});

describe('composeWeekPlan — birthdays + family events', () => {
  it("includes a non-teen child's in-window birthday, named and dated", () => {
    const [item = MISSING_ITEM] = composeWeekPlan(
      inputs({ children: [{ id: BABY, name: 'Maya', dateOfBirth: BABY_DOB_IN_WINDOW }] }),
      NOW,
    );
    expect(item).toMatchObject({
      kind: 'birthday',
      title: "Maya's birthday",
      startsAt: '2026-07-30',
      childIds: [BABY],
      privacySensitive: false,
    });
  });

  it('excludes a birthday outside the week window', () => {
    const items = composeWeekPlan(
      inputs({ children: [{ id: BABY, name: 'Maya', dateOfBirth: '2025-09-01' }] }),
      NOW,
    );
    expect(items).toEqual([]);
  });

  it("redacts a teen's in-window birthday to a nameless generic line", () => {
    // Only the teen, whose birthday 07-31 is in-window.
    const [item = MISSING_ITEM] = composeWeekPlan(
      inputs({ children: [{ id: TEEN, name: 'Sam', dateOfBirth: TEEN_DOB_IN_WINDOW }] }),
      NOW,
    );
    expect(item.title).toBe('a birthday in the family');
    expect(item.title).not.toContain('Sam');
  });

  it('clamps a Feb-29 birthday to Feb-28 in a common year', () => {
    const win: WeekWindow = {
      startKey: '2027-02-22',
      endKey: '2027-02-28',
      dayKeys: ['2027-02-22', '2027-02-23', '2027-02-24', '2027-02-25', '2027-02-26', '2027-02-27', '2027-02-28'],
    };
    const [item = MISSING_ITEM] = composeWeekPlan(
      inputs({ window: win, children: [{ id: BABY, name: 'Leap', dateOfBirth: '2024-02-29' }] }),
      new Date('2027-02-22T12:00:00Z'),
    );
    expect(item.startsAt).toBe('2027-02-28');
  });

  it("folds a family_events occasion into the birthday kind with its title, date, and place", () => {
    const [item = MISSING_ITEM] = composeWeekPlan(
      inputs({
        children: [],
        familyEvents: [
          { id: 'e1', childId: null, title: "Leo's party", startKey: '2026-07-31', endKey: null, location: 'Riverside Park' },
        ],
      }),
      NOW,
    );
    expect(item).toMatchObject({
      kind: 'birthday',
      title: "Leo's party",
      startsAt: '2026-07-31',
      location: 'Riverside Park',
      sourceRef: { table: 'family_events', id: 'e1' },
    });
  });
});

describe('composeWeekPlan — village, suggestion, ordering', () => {
  it('includes an in-window saved village activity and drops an out-of-window one', () => {
    const items = composeWeekPlan(
      inputs({
        children: [],
        villageDated: [
          { id: 'v1', title: 'Storytime', eventDate: '2026-07-29', location: 'Library' },
          { id: 'v2', title: 'Far Fair', eventDate: '2026-08-20', location: null },
        ],
      }),
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'village', title: 'Storytime', startsAt: '2026-07-29', needs: 'calendar_add' });
  });

  it('places the one suggestion last and marks it a decision, never auto-scheduled', () => {
    const items = composeWeekPlan(
      inputs({
        children: [],
        villageDated: [{ id: 'v1', title: 'Storytime', eventDate: '2026-07-29', location: null }],
        suggestion: { id: 's1', title: 'Nature walk', eventDate: null, location: null },
      }),
      NOW,
    );
    expect(items.at(-1)).toMatchObject({ kind: 'suggestion', title: 'Nature walk', needs: 'decision' });
  });

  it('orders appointments > birthdays > village > routines > suggestion', () => {
    const items = composeWeekPlan(
      inputs({
        children: [{ id: BABY, name: 'Maya', dateOfBirth: BABY_DOB_IN_WINDOW }],
        health: [{ childId: BABY, what: 'checkup', kind: 'well_child_visit', dueInWeeks: 0 }],
        villageDated: [{ id: 'v1', title: 'Storytime', eventDate: '2026-07-29', location: null }],
        routines: [{ label: 'weekday mornings: breakfast', day: null }],
        suggestion: { id: 's1', title: 'Nature walk', eventDate: null, location: null },
      }),
      NOW,
    );
    expect(items.map((i) => i.kind)).toEqual(['appointment', 'birthday', 'village', 'routine', 'suggestion']);
  });
});

describe('composeWeekPlan — cap + routine overflow', () => {
  it(`caps at ${MAX_ITEMS}, collapsing routine overflow to one summary line while keeping concrete items + the suggestion`, () => {
    const villageDated = Array.from({ length: 6 }, (_, i) => ({
      id: `v${i}`,
      title: `Activity ${i}`,
      eventDate: '2026-07-29',
      location: null,
    }));
    const routines = Array.from({ length: 5 }, (_, i) => ({ label: `routine ${i}`, day: null }));
    const items = composeWeekPlan(
      inputs({ children: [], villageDated, routines, suggestion: { id: 's1', title: 'Nature walk', eventDate: null, location: null } }),
      NOW,
    );
    expect(items).toHaveLength(MAX_ITEMS);
    // 6 village kept, routines collapsed to ONE summary, suggestion last.
    expect(items.filter((i) => i.kind === 'village')).toHaveLength(6);
    const routineItems = items.filter((i) => i.kind === 'routine');
    expect(routineItems).toHaveLength(1);
    expect(routineItems[0]?.title).toBe('and your usual routines');
    expect(items.at(-1)?.kind).toBe('suggestion');
  });

  it('keeps every routine when they all fit under the cap (no summary collapse)', () => {
    const items = composeWeekPlan(
      inputs({
        children: [],
        villageDated: [{ id: 'v1', title: 'Storytime', eventDate: '2026-07-29', location: null }],
        routines: [
          { label: 'routine a', day: null },
          { label: 'routine b', day: null },
          { label: 'routine c', day: null },
        ],
      }),
      NOW,
    );
    expect(items.filter((i) => i.kind === 'routine').map((i) => i.title)).toEqual(['routine a', 'routine b', 'routine c']);
  });
});
