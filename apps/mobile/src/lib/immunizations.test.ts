import { describe, expect, it } from 'vitest';

import type { UpcomingHealthItem } from './api-types';
import { immunizationView } from './immunizations';

/** A minimal UpcomingHealthItem, defaulting to an immunization; override per case. */
function item(over: Partial<UpcomingHealthItem>): UpcomingHealthItem {
  return {
    ageMonths: 15,
    kind: 'immunization',
    what: '15-month immunizations',
    note: '',
    key: '15-immunization',
    dueInWeeks: 4,
    done: false,
    ...over,
  };
}

describe('immunizationView — the age-derived Immunizations page state', () => {
  it('is up to date only when NO immunization is overdue', () => {
    const view = immunizationView({
      nextHealth: [item({ key: '15-immunization', dueInWeeks: 4 })],
      recentlyPassedHealth: [],
    });
    expect(view.upToDate).toBe(true);
    expect(view.overdue).toEqual([]);
  });

  it('is NOT up to date when a passed immunization sits in recentlyPassedHealth', () => {
    const overdueShot = item({ key: '12-immunization', ageMonths: 12, dueInWeeks: -6 });
    const view = immunizationView({
      nextHealth: [item({ key: '15-immunization' })],
      recentlyPassedHealth: [overdueShot],
    });
    expect(view.upToDate).toBe(false);
    expect(view.overdue).toEqual([overdueShot]);
  });

  it('ignores a recently-passed WELL-CHILD VISIT — only immunizations gate the banner', () => {
    // A missed 12-month checkup is not an overdue shot; the banner stays green.
    const view = immunizationView({
      nextHealth: [],
      recentlyPassedHealth: [item({ kind: 'well_child_visit', key: '12-well_child_visit' })],
    });
    expect(view.upToDate).toBe(true);
    expect(view.overdue).toEqual([]);
  });

  it('picks the FIRST immunization in soonest-first nextHealth as next due', () => {
    const soon = item({ key: '15-immunization', ageMonths: 15, dueInWeeks: 2 });
    const later = item({ key: '18-immunization', ageMonths: 18, dueInWeeks: 14 });
    const view = immunizationView({
      // A well-child visit ahead of the shot must not be chosen as the next shot.
      nextHealth: [item({ kind: 'well_child_visit', key: '15-well_child_visit' }), soon, later],
      recentlyPassedHealth: [],
    });
    expect(view.nextDue).toEqual(soon);
  });

  it('has no next due once the child is past the routine immunization schedule', () => {
    const view = immunizationView({
      nextHealth: [item({ kind: 'well_child_visit', key: '48-well_child_visit' })],
      recentlyPassedHealth: [],
    });
    expect(view.nextDue).toBeNull();
  });
});
