import { describe, expect, it } from 'vitest';
import { CONFIRM_WITH_PROVIDER, companionForChild } from './index.js';

/**
 * Expected values are derived from the curated schedule in companion.ts, not
 * copied from output: the Canadian routine cadence (immunizations at 2/4/6/12/
 * 15/18 months and 4–6 years) and the stage boundaries [12, 48, 156].
 *
 * `now` is fixed and births are chosen so the completed-month age is exact: a
 * day-15 birth read against a day-15 "now" lands on a clean monthly anniversary.
 */
const NOW = new Date(2026, 5, 15); // 2026-06-15

describe('companionForChild — health timeline', () => {
  it("a 3-month-old's next health item is the 4-month set, soonest first", () => {
    // Born 2026-03-15 → exactly 3mo on 2026-06-15. The 2-month items are behind
    // it and dropped; the soonest upcoming entry is the 4-month visit/shots.
    const view = companionForChild({ dateOfBirth: '2026-03-15' }, NOW);

    expect(view.ageMonths).toBe(3);
    expect(view.stage).toBe('newborn');
    // 2-month items are in the past and excluded.
    expect(view.nextHealth.some((h) => h.ageMonths === 2)).toBe(false);
    // The first upcoming items are the 4-month set.
    expect(view.nextHealth[0]?.ageMonths).toBe(4);
    // Both the 4-month visit and immunizations are present.
    expect(view.nextHealth.filter((h) => h.ageMonths === 4).map((h) => h.kind).sort()).toEqual([
      'immunization',
      'well_child_visit',
    ]);
    // Due in ~1 month → round(1 * 4.345) = 4 weeks.
    expect(view.nextHealth[0]?.dueInWeeks).toBe(4);
    // Soonest-first ordering by scheduled age.
    const ages = view.nextHealth.map((h) => h.ageMonths);
    expect(ages).toEqual([...ages].sort((a, b) => a - b));
  });

  it('includes the 4-month immunizations exactly one set ahead for a 3-month-old', () => {
    const view = companionForChild({ dateOfBirth: '2026-03-15' }, NOW);
    const fourMonthShots = view.nextHealth.find(
      (h) => h.ageMonths === 4 && h.kind === 'immunization',
    );
    expect(fourMonthShots?.what).toBe('4-month immunizations');
  });

  it('drops past items: an 18-month-old has no infant immunizations left, next is 4–6y', () => {
    // Born 2024-12-15 → 18mo on 2026-06-15. Everything through 18mo is at-or-past
    // its own age, so the 18mo items remain (>= current age) but nothing earlier.
    const view = companionForChild({ dateOfBirth: '2024-12-15' }, NOW);
    expect(view.ageMonths).toBe(18);
    expect(view.nextHealth.some((h) => h.ageMonths < 18)).toBe(false);
    // The next milestone-grade health items after 18mo are the 4–6y (60mo) set.
    const after18 = view.nextHealth.filter((h) => h.ageMonths > 18).map((h) => h.ageMonths);
    expect(after18[0]).toBe(60);
  });

  it("a teen-aged child has no upcoming health items but keeps 'what matters now'", () => {
    // Born 2013-05-15 → 157mo on 2026-06-15 → teenager. The curated routine
    // schedule's last entry is the 144mo (pre-teen) set, so a 13+ child has run
    // off the end of the timeline: nextHealth is empty. whatsNow is keyed by
    // stage, so it stays non-empty — Home's Today fills the freed card with it.
    const view = companionForChild({ dateOfBirth: '2013-05-15' }, NOW);
    expect(view.stage).toBe('teenager');
    expect(view.nextHealth).toHaveLength(0);
    expect(view.whatsNow.length).toBeGreaterThan(0);
  });
});

describe('companionForChild — milestones', () => {
  it("a 13-month-old's milestone list includes walking and first words, both in-window", () => {
    // Born 2025-05-15 → 13mo on 2026-06-15 → toddler (>=12mo).
    const view = companionForChild({ dateOfBirth: '2025-05-15' }, NOW);
    expect(view.ageMonths).toBe(13);
    expect(view.stage).toBe('toddler');

    const walk = view.milestones.find((m) => m.what === 'Walks independently');
    const firstWords = view.milestones.find((m) => m.what === 'Says first words');
    expect(walk).toBeTruthy();
    expect(firstWords).toBeTruthy();
    // 13mo sits inside the [12,18] window for both.
    expect(walk?.timing).toBe('in_window');
    expect(firstWords?.timing).toBe('in_window');
  });

  it("tags a milestone 'upcoming' before its window and 'watch' past it", () => {
    // A 2-month-old (born 2026-04-15) is a newborn: "Sits without support" [6,9]
    // is upcoming; "First social smile" [1,3] is in-window.
    const young = companionForChild({ dateOfBirth: '2026-04-15' }, NOW);
    expect(young.ageMonths).toBe(2);
    expect(young.milestones.find((m) => m.what === 'Sits without support')?.timing).toBe(
      'upcoming',
    );
    expect(young.milestones.find((m) => m.what === 'First social smile')?.timing).toBe(
      'in_window',
    );

    // An 11-month-old (still newborn stage, <12mo) is past every newborn window
    // top-bound (max is 9mo) → "Rolls over" [4,6] reads 'watch' (worth asking).
    const older = companionForChild({ dateOfBirth: '2025-07-15' }, NOW);
    expect(older.ageMonths).toBe(11);
    expect(older.stage).toBe('newborn');
    expect(older.milestones.find((m) => m.what === 'Rolls over')?.timing).toBe('watch');
  });

  it('returns teenager milestones for a 13-year-old', () => {
    // Born 2013-05-15 → 157mo on 2026-06-15 → teenager (>=156mo).
    const view = companionForChild({ dateOfBirth: '2013-05-15' }, NOW);
    expect(view.stage).toBe('teenager');
    expect(view.milestones.map((m) => m.area)).toContain('independence');
    expect(view.milestones.some((m) => m.what === 'Walks independently')).toBe(false);
  });
});

describe('companionForChild — guidance and safety framing (rule #1)', () => {
  it("surfaces stage 'what matters now' and the next stage transition", () => {
    const newborn = companionForChild({ dateOfBirth: '2026-03-15', name: 'Maya' }, NOW);
    expect(newborn.name).toBe('Maya');
    expect(newborn.whatsNow.length).toBeGreaterThan(0);
    expect(newborn.whatsNext).toContain('toddler');
  });

  it('attaches the confirm-with-provider note to every health and milestone item', () => {
    const view = companionForChild({ dateOfBirth: '2026-03-15' }, NOW);
    expect(view.nextHealth.every((h) => h.note === CONFIRM_WITH_PROVIDER)).toBe(true);
    expect(view.milestones.every((m) => m.note === CONFIRM_WITH_PROVIDER)).toBe(true);
  });

  it('echoes a null name when none is provided', () => {
    const view = companionForChild({ dateOfBirth: '2026-03-15' }, NOW);
    expect(view.name).toBeNull();
  });
});
