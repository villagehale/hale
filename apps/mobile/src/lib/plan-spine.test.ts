import { describe, expect, it } from 'vitest';
import type { AuthoredPlanView } from './api-types';
import { buildPlanSpine } from './plan-spine';

// A plan factory keyed to what the spine cares about (date + completion). The
// non-load-bearing fields are fixed so each case reads as just its date/state.
function plan(over: Partial<AuthoredPlanView> & { id: string }): AuthoredPlanView {
  return {
    title: 'swim',
    notes: null,
    scheduledFor: null,
    completedAt: null,
    childId: null,
    childName: null,
    ...over,
  };
}

// Anchor: Wednesday 2026-07-08, 15:00 UTC. In America/Toronto (UTC-4 in July) that's
// still Wed the 8th, so the week is Mon 2026-07-06 → Sun 2026-07-12.
const WED_JULY_8 = new Date('2026-07-08T15:00:00Z');
const TZ = 'America/Toronto';

describe('buildPlanSpine — Mon–Sun week folding', () => {
  it('lays a dated plan on its weekday column, keyed to the exact YYYY-MM-DD', () => {
    const p = plan({ id: 'p1', scheduledFor: '2026-07-10T00:00:00.000Z' }); // Friday
    const spine = buildPlanSpine([p], WED_JULY_8, TZ);

    expect(spine.days.map((d) => d.weekday)).toEqual([
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ]);
    const monday = spine.days[0];
    expect(monday.weekday).toBe('monday');
    expect(monday.dateKey).toBe('2026-07-06');
    const friday = spine.days.find((d) => d.weekday === 'friday');
    expect(friday?.dateKey).toBe('2026-07-10');
    expect(friday?.plans).toEqual([p]);
    // No other day carries it.
    expect(spine.days.filter((d) => d.plans.length > 0)).toHaveLength(1);
    expect(spine.undated).toHaveLength(0);
    expect(spine.settled).toHaveLength(0);
  });

  it('puts an undated open plan in the "sometime this week" tail, not on a day', () => {
    const p = plan({ id: 'p1', scheduledFor: null });
    const spine = buildPlanSpine([p], WED_JULY_8, TZ);

    expect(spine.undated).toEqual([p]);
    expect(spine.days.every((d) => d.plans.length === 0)).toBe(true);
    expect(spine.settled).toHaveLength(0);
  });

  it('settles a completed plan regardless of its date', () => {
    const p = plan({
      id: 'p1',
      scheduledFor: '2026-07-10T00:00:00.000Z',
      completedAt: '2026-07-08T12:00:00.000Z',
    });
    const spine = buildPlanSpine([p], WED_JULY_8, TZ);

    expect(spine.settled).toEqual([p]);
    expect(spine.days.every((d) => d.plans.length === 0)).toBe(true);
    expect(spine.undated).toHaveLength(0);
  });

  it('settles a past-dated open plan (dated before this Monday)', () => {
    const p = plan({ id: 'p1', scheduledFor: '2026-07-01T00:00:00.000Z' }); // last week
    const spine = buildPlanSpine([p], WED_JULY_8, TZ);

    expect(spine.settled).toEqual([p]);
    expect(spine.days.every((d) => d.plans.length === 0)).toBe(true);
  });

  it('routes a future-week dated plan to the undated tail (never dropped)', () => {
    const p = plan({ id: 'p1', scheduledFor: '2026-07-20T00:00:00.000Z' }); // next-next Mon
    const spine = buildPlanSpine([p], WED_JULY_8, TZ);

    expect(spine.undated).toEqual([p]);
    expect(spine.days.every((d) => d.plans.length === 0)).toBe(true);
    expect(spine.settled).toHaveLength(0);
  });

  it('judges the week in the family zone: 11pm ET Sunday is still that Sunday, not Monday UTC', () => {
    // 2026-07-12 23:30 ET is 2026-07-13 03:30 UTC. The family is on Sunday the 12th,
    // so the week is Mon 07-06 → Sun 07-12 and a Sunday-12 plan lands on Sunday —
    // NOT bumped into next week by the UTC rollover.
    const lateSundayET = new Date('2026-07-13T03:30:00Z');
    const p = plan({ id: 'p1', scheduledFor: '2026-07-12T00:00:00.000Z' });
    const spine = buildPlanSpine([p], lateSundayET, TZ);

    const sunday = spine.days.find((d) => d.weekday === 'sunday');
    expect(sunday?.dateKey).toBe('2026-07-12');
    expect(sunday?.plans).toEqual([p]);
    expect(spine.undated).toHaveLength(0);
    expect(spine.settled).toHaveLength(0);
  });
});
