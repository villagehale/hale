import { describe, expect, it } from 'vitest';
import {
  CONFIRM_WITH_PROVIDER,
  HEALTH_HORIZON_MONTHS,
  companionForChild,
  healthItemKey,
  milestoneStatusLabel,
  stageDisplayLabel,
} from './index.js';

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

  /**
   * VIL-260 · WS5 — milestone honesty.
   *
   * The module's own framing is "most kids by X — IF NOT, worth asking". That
   * sentence is a prompt with a shelf life: it is worth saying while the answer
   * could still change something, and it stops being worth saying long after.
   * Under a permanent 'watch' every one of the five toddler rows read as a
   * developmental warning by 47 months, which is the alarmist register rule #1
   * exists to forbid. The expectations below are read off that sentence, not off
   * the code: still asking at 24 months, no longer shouting at 47.
   */
  it("keeps 'worth asking' live while asking could still change something", () => {
    // Born 2024-06-15 → exactly 24mo. Walking typically arrives by 18 months, so a
    // two-year-old who is not walking is a real, useful thing to raise.
    const two = companionForChild({ dateOfBirth: '2024-06-15' }, NOW);
    expect(two.ageMonths).toBe(24);
    expect(two.milestones.find((m) => m.what === 'Walks independently')?.timing).toBe('watch');
    expect(two.milestones.find((m) => m.what === 'Says first words')?.timing).toBe('watch');
  });

  it('stops flagging a long-past window — a 47-month-old is not five warnings', () => {
    // Born 2022-07-15 → 47mo, the last month of the toddler stage. Four of the five
    // toddler windows closed six months or more ago; only potty-training interest
    // (through 42mo) is still a live question.
    const nearlyFour = companionForChild({ dateOfBirth: '2022-07-15' }, NOW);
    expect(nearlyFour.ageMonths).toBe(47);
    expect(nearlyFour.stage).toBe('toddler');

    const watching = nearlyFour.milestones.filter((m) => m.timing === 'watch');
    expect(watching.map((m) => m.what)).toEqual(['Shows interest in potty training']);
    expect(nearlyFour.milestones.find((m) => m.what === 'Walks independently')?.timing).toBe(
      'passed',
    );
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

describe('companionForChild — done marking', () => {
  it('flips a milestone to done when its exact `what` is in the done set', () => {
    // 13-month-old toddler: "Walks independently" is in-window. Marking it done
    // must set done:true on that milestone and leave the others done:false.
    const done = { milestones: new Set(['Walks independently']), health: new Set<string>() };
    const view = companionForChild({ dateOfBirth: '2025-05-15' }, NOW, done);

    const walk = view.milestones.find((m) => m.what === 'Walks independently');
    const words = view.milestones.find((m) => m.what === 'Says first words');
    expect(walk?.done).toBe(true);
    expect(words?.done).toBe(false);
    // Done never removes a milestone — it stays in the list, just flagged.
    expect(view.milestones).toHaveLength(
      companionForChild({ dateOfBirth: '2025-05-15' }, NOW).milestones.length,
    );
  });

  it('defaults every item to not-done when no done set is passed', () => {
    const view = companionForChild({ dateOfBirth: '2025-05-15' }, NOW);
    expect(view.milestones.every((m) => m.done === false)).toBe(true);
    expect(view.nextHealth.every((h) => h.done === false)).toBe(true);
  });

  it('carries a stable health key that matches healthItemKey and flips done for it', () => {
    // 3-month-old: the soonest upcoming item is the 4-month well-baby visit.
    const target = { ageMonths: 4, kind: 'well_child_visit' as const };
    const key = healthItemKey(target);
    const done = { milestones: new Set<string>(), health: new Set([key]) };
    const view = companionForChild({ dateOfBirth: '2026-03-15' }, NOW, done);

    const visit = view.nextHealth.find((h) => h.key === key);
    expect(visit?.what).toBe('4-month well-baby visit');
    expect(visit?.done).toBe(true);
    // The 4-month immunizations share the age but not the key → still not done.
    const shots = view.nextHealth.find(
      (h) => h.key === healthItemKey({ ageMonths: 4, kind: 'immunization' }),
    );
    expect(shots?.done).toBe(false);
  });
});

describe('milestoneStatusLabel — what a parent actually reads', () => {
  it('a Done marker CLEARS the prompt instead of sitting beside it', () => {
    // The defect: tapping Done set a flag nothing read, so the row kept saying
    // "worth asking" about something the parent had just told us had happened.
    expect(milestoneStatusLabel({ timing: 'watch', done: false })).toBe('worth asking');
    expect(milestoneStatusLabel({ timing: 'watch', done: true })).not.toBe('worth asking');
    expect(milestoneStatusLabel({ timing: 'watch', done: true })).toBe(
      milestoneStatusLabel({ timing: 'upcoming', done: true }),
    );
  });

  it('says nothing alarming about a window that simply closed', () => {
    const label = milestoneStatusLabel({ timing: 'passed', done: false });
    expect(label).not.toMatch(/late|behind|delay|overdue|missed|should/i);
  });

  it('gives every timing a label, so a new one can never render as undefined', () => {
    for (const timing of ['upcoming', 'in_window', 'watch', 'passed'] as const) {
      expect(milestoneStatusLabel({ timing, done: false })).toMatch(/\S/);
    }
  });
});

describe('companionForChild — the preschool years inside the child stage', () => {
  /**
   * VIL-260 · WS5. `deriveStage` puts every child from 48 months to 12 years in
   * one 'child' bucket, so a four-year-old was being handed an eight-year-old's
   * material: badged school-age, offered homework and screen-time boundaries, and
   * shown a milestone list whose earliest window opens a year after their age.
   * These assert the age-derived view, NOT a new stage value — the four-bucket
   * stage is untouched and still the teen gate.
   */
  it('does not call a four-year-old school-age', () => {
    // Born 2022-05-15 → 49mo. Same stage as a ten-year-old, not the same childhood.
    const four = companionForChild({ dateOfBirth: '2022-05-15' }, NOW);
    expect(four.ageMonths).toBe(49);
    expect(four.stage).toBe('child');
    expect(stageDisplayLabel(four.stage, four.ageMonths)).toBe('preschool');
    expect(stageDisplayLabel('child', 96)).toBe('school-age');
  });

  it('gives a four-year-old milestones their own age can be in', () => {
    const four = companionForChild({ dateOfBirth: '2022-05-15' }, NOW);
    expect(four.milestones.some((m) => m.timing === 'in_window')).toBe(true);
    // Not the eight-year-old's list.
    expect(four.milestones.some((m) => m.what.toLowerCase().includes('homework'))).toBe(false);
  });

  it('does not hand a four-year-old school-age guidance', () => {
    const four = companionForChild({ dateOfBirth: '2022-05-15' }, NOW);
    const eight = companionForChild({ dateOfBirth: '2018-06-15' }, NOW);
    expect(eight.ageMonths).toBe(96);
    expect(four.whatsNow).not.toEqual(eight.whatsNow);
    expect(four.whatsNow.join(' ')).not.toMatch(/homework|screen-time/i);
    // A toddler is told what actually comes next, not that they turn school-age.
    const toddler = companionForChild({ dateOfBirth: '2024-06-15' }, NOW);
    expect(toddler.whatsNext).not.toMatch(/school-age/i);
  });

  it('still hands a school-age child their own guidance and list', () => {
    const eight = companionForChild({ dateOfBirth: '2018-06-15' }, NOW);
    expect(eight.stage).toBe('child');
    expect(eight.whatsNow.join(' ')).toMatch(/school/i);
    expect(eight.milestones.some((m) => m.what === 'Manages homework with some support')).toBe(true);
  });
});

describe('companionForChild — recently-passed health (not silently dropped)', () => {
  it('surfaces a recently-passed, not-done item as a passed item with a negative dueInWeeks', () => {
    // Born 2026-01-15 → 5mo on 2026-06-15. The 4-month set passed 1 month ago and
    // is within RECENT_PASSED_MONTHS(3), so it surfaces in recentlyPassedHealth —
    // NOT in nextHealth (which is at-or-after age only).
    const view = companionForChild({ dateOfBirth: '2026-01-15' }, NOW);
    expect(view.ageMonths).toBe(5);

    const passedAges = view.recentlyPassedHealth.map((h) => h.ageMonths);
    expect(passedAges).toContain(4);
    // It's genuinely passed: negative weeks-until.
    const fourMonthVisit = view.recentlyPassedHealth.find(
      (h) => h.ageMonths === 4 && h.kind === 'well_child_visit',
    );
    expect(fourMonthVisit).toBeTruthy();
    expect(fourMonthVisit?.dueInWeeks).toBeLessThan(0);
    // And it is not double-counted into the upcoming list.
    expect(view.nextHealth.some((h) => h.ageMonths === 4)).toBe(false);
  });

  it('drops a recently-passed item from recentlyPassedHealth once it is marked done', () => {
    const key = healthItemKey({ ageMonths: 4, kind: 'well_child_visit' });
    const done = { milestones: new Set<string>(), health: new Set([key]) };
    const view = companionForChild({ dateOfBirth: '2026-01-15' }, NOW, done);
    expect(view.recentlyPassedHealth.some((h) => h.key === key)).toBe(false);
  });

  it('does not resurface an item that passed longer ago than RECENT_PASSED_MONTHS', () => {
    // Born 2025-11-15 → 7mo. The 2-month set passed 5 months ago (> 3) → gone; the
    // 6-month set passed 1 month ago → surfaces.
    const view = companionForChild({ dateOfBirth: '2025-11-15' }, NOW);
    expect(view.ageMonths).toBe(7);
    const passedAges = view.recentlyPassedHealth.map((h) => h.ageMonths);
    expect(passedAges).toContain(6);
    expect(passedAges).not.toContain(2);
  });
});

describe('companionForChild — todayHealth horizon gate', () => {
  it('leads with the soonest upcoming item when it is within the horizon', () => {
    // 3-month-old: next is the 4-month set, ~1 month out (within horizon).
    const view = companionForChild({ dateOfBirth: '2026-03-15' }, NOW);
    expect(view.todayHealth?.ageMonths).toBe(4);
  });

  it('returns null rather than leading with a checkup years away', () => {
    // Born 2024-10-15 → 20mo. The 18-month set has passed; the next real routine
    // item is the 4–6 year (60mo) set — 40 months out, far beyond the horizon.
    const view = companionForChild({ dateOfBirth: '2024-10-15' }, NOW);
    expect(view.ageMonths).toBe(20);
    expect(view.nextHealth[0]?.ageMonths).toBe(60);
    // The list still shows the far item, but the "today" lead is suppressed.
    expect(view.nextHealth[0] && view.nextHealth[0].ageMonths - view.ageMonths).toBeGreaterThan(
      HEALTH_HORIZON_MONTHS,
    );
    expect(view.todayHealth).toBeNull();
  });

  it('skips a done upcoming item when choosing the today lead', () => {
    // 3-month-old whose 4-month visit is already done → the lead advances to the
    // next not-done in-horizon item (the 4-month immunizations, same age).
    const doneKey = healthItemKey({ ageMonths: 4, kind: 'well_child_visit' });
    const done = { milestones: new Set<string>(), health: new Set([doneKey]) };
    const view = companionForChild({ dateOfBirth: '2026-03-15' }, NOW, done);
    expect(view.todayHealth?.done).toBe(false);
    expect(view.todayHealth?.key).not.toBe(doneKey);
  });
});
